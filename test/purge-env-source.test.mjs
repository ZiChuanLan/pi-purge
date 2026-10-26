import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 仍然断言插件不写任何状态文件
const SANDBOX = mkdtempSync(join(tmpdir(), "pi-purge-env-test-"));
process.env.HOME = SANDBOX;
process.env.USERPROFILE = SANDBOX;
process.chdir(SANDBOX);

const SOURCE_DIR = mkdtempSync(join(tmpdir(), "pi-purge-env-src-"));
const ENV_FILE = join(SOURCE_DIR, "env-persona.md");
const ENV_BODY = "# Env persona\n\nLoaded from PI_PURGE_SOURCE.";
const OPT_FILE = join(SOURCE_DIR, "opt-persona.md");
const OPT_BODY = "# Option persona\n\nLoaded from plugin options.";
writeFileSync(ENV_FILE, ENV_BODY, "utf8");
writeFileSync(OPT_FILE, OPT_BODY, "utf8");

// 默认源在 setup 时求值，所以必须在 createHost 之前设置
process.env.PI_PURGE_SOURCE = ENV_FILE;
const { createHost, stockSystem } = await import("./host.mjs");

const SES = "ses_env";

try {
	// 1. 仍然是默认关闭，但默认源已经变成 PI_PURGE_SOURCE
	const host = await createHost();
	assert.deepEqual(await host.inject(SES), stockSystem(), "默认关闭时不注入");
	await host.run(SES, "status");
	assert.match(host.lastNote(), /状态: 关闭/, "启动仍然默认关闭");
	assert.ok(host.lastNote().includes(ENV_FILE), "status 显示 PI_PURGE_SOURCE 的路径");
	assert.ok(host.lastNote().includes(`${ENV_BODY.length} 字符`), "status 显示该文件的字符数");

	// 2. /purge on 直接使用环境变量指向的正文
	await host.run(SES, "on");
	const system = await host.inject(SES);
	assert.ok(system[0].text.startsWith("# Env persona"), "注入 PI_PURGE_SOURCE 指向的正文");
	assert.ok(!system.map((part) => part.text).join("\n").includes("coding agent harness"), "strict 仍丢弃宿主提示词");
	assert.equal(system.at(-1).text, "Current working directory: H:/WorkSpace", "strict 仍只追加 cwd");
	assert.ok(!system[0].text.includes("helpful assistant"), "没有回退到内嵌示例");

	// 3. 显式 /purge source 仍然优先于环境变量
	await host.run(SES, "source embedded");
	await host.run(SES, "on");
	assert.ok((await host.inject(SES))[0].text.includes("helpful assistant"), "/purge source embedded 覆盖 PI_PURGE_SOURCE");

	// 4. 环境变量只给初始值：另一个会话仍然从环境变量的源、关闭状态开始
	await host.run("ses_other", "status");
	assert.ok(host.lastNote().includes(ENV_FILE), "新会话的初始源仍是 PI_PURGE_SOURCE");
	assert.match(host.lastNote(), /状态: 关闭/);

	// 5. 插件配置 options 优先于环境变量；mode 同样可以预设
	const configured = await createHost({ options: { source: OPT_FILE, mode: "append" } });
	await configured.run(SES, "on");
	assert.match(configured.lastNote(), /append/, "options.mode 预设生效");
	const configuredSystem = await configured.inject(SES);
	assert.equal(configuredSystem[0].text, OPT_BODY, "options.source 优先于 PI_PURGE_SOURCE");
	assert.deepEqual(configuredSystem.slice(1), stockSystem(), "append 模式下宿主提示词原样保留");

	// 6. 无效的 options 不会让插件起不来：回退到 strict + 环境变量
	const sloppy = await createHost({ options: { source: 42, mode: "nonsense" } });
	await sloppy.run(SES, "status");
	assert.match(sloppy.lastNote(), /模式: strict/, "无效 mode 回退 strict");
	assert.ok(sloppy.lastNote().includes(ENV_FILE), "非字符串 source 被忽略，回到环境变量");

	// 7. 环境变量指向的文件不存在时，/purge on 报错而不是静默回退到内嵌示例
	process.env.PI_PURGE_SOURCE = join(SOURCE_DIR, "missing.md");
	const missing = await createHost();
	await missing.run(SES, "on");
	assert.equal(missing.sent.at(-1).metadata.level, "error", "文件不存在时开启失败");
	assert.match(missing.lastNote(), /文件不存在/);
	assert.deepEqual(await missing.inject(SES), stockSystem(), "开启失败时系统提示词保持原样");

	// 8. 仍然不写盘
	assert.deepEqual(readdirSync(SANDBOX), [], "不写任何状态文件");

	console.log("OK — PI_PURGE_SOURCE / options 断言通过");
} finally {
	rmSync(SANDBOX, { recursive: true, force: true });
	rmSync(SOURCE_DIR, { recursive: true, force: true });
}
