import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 插件不写任何状态文件：把 HOME 和 cwd 都指到空目录，跑完仍然为空就是证据
const SANDBOX = mkdtempSync(join(tmpdir(), "pi-purge-test-"));
const PERSONA_DIR = mkdtempSync(join(tmpdir(), "pi-purge-persona-"));
process.env.HOME = SANDBOX;
process.env.USERPROFILE = SANDBOX;
process.chdir(SANDBOX);
// 默认源在 setup 时求值：清掉 shell 里可能导出的 PI_PURGE_SOURCE，保证本套件跑内嵌源
delete process.env.PI_PURGE_SOURCE;

const { createHost, stockSystem, HARNESS_PROMPT, INITIAL_CONTEXT } = await import("./host.mjs");

const SES_A = "ses_a";
const SES_B = "ses_b";
const joined = (system) => system.map((part) => part.text).join("\n");

try {
	const host = await createHost();
	const { run, inject, lastNote } = host;

	// 0. 命令注册
	assert.deepEqual([...host.commands.keys()], ["purge"], "只注册 /purge 一个命令");
	assert.ok(host.commands.get("purge").description, "命令带描述");
	assert.deepEqual([...host.hooks.keys()], ["context"], "只挂 context 一个运行时钩子");

	// 1. 默认关闭，且不碰系统提示词
	assert.deepEqual(await inject(SES_A), stockSystem(), "默认关闭，不碰系统提示词");
	await run(SES_A, "status");
	assert.match(lastNote(), /人设: 内嵌/, "默认人设来自内嵌常量");
	assert.match(lastNote(), /状态: 关闭/);
	assert.match(lastNote(), /仅本会话/);

	// 2. 开启（默认 strict）：内嵌人设 + 工作目录，宿主提示词整段丢弃
	await run(SES_A, "on");
	const strictOn = await inject(SES_A);
	assert.equal(strictOn.length, 2, "strict 只有人设和工作目录两段");
	assert.ok(strictOn[0].text.includes("helpful assistant"), "内嵌人设已注入");
	assert.equal(strictOn[1].text, "Current working directory: H:/WorkSpace", "strict 保留工作目录，反斜杠归一");
	assert.ok(!joined(strictOn).includes("coding agent harness"), "strict 丢掉宿主身份句");
	assert.ok(!joined(strictOn).includes("# Harness"), "strict 丢掉宿主结构");
	assert.ok(!joined(strictOn).includes("<project_instructions"), "strict 丢掉项目上下文");

	// 3. ★ 通知只记入会话、不唤醒模型
	assert.ok(host.sent.length > 0);
	for (const note of host.sent) {
		assert.equal(note.resume, false, "通知必须 resume:false，否则每条 /purge 反馈都会触发一次模型调用");
		assert.equal(note.description, "pi-purge");
	}
	assert.equal(host.sent[0].sessionID, SES_A, "通知发回执行命令的会话");

	// 4. ★ 会话级独立：状态按 sessionID 隔离
	assert.deepEqual(await inject(SES_B), stockSystem(), "另一个会话（如子 agent）不继承开启状态");
	await run(SES_B, "status");
	assert.match(lastNote(), /状态: 关闭/);
	// 插件重载 = 新的 setup，状态不跨重载保留
	const reloaded = await createHost();
	assert.deepEqual(await reloaded.inject(SES_A), stockSystem(), "插件重载后回到关闭");

	// 5. 三种模式
	await run(SES_A, "mode replace");
	const replaced = await inject(SES_A);
	assert.ok(replaced[0].text.includes("helpful assistant"), "replace 人设在最前");
	assert.ok(!joined(replaced).includes("You are an AI agent running in OpenCode"), "replace 切除身份句");
	assert.ok(!replaced[1].text.startsWith("\n"), "切除后不留开头空行");
	for (const keep of ["# Harness", "- Prefer dedicated tools over shell commands", "# Working in codebases"]) {
		assert.ok(replaced[1].text.includes(keep), `replace 保留宿主结构: ${keep}`);
	}
	assert.equal(replaced[2].text, INITIAL_CONTEXT, "replace 不动项目上下文段");
	await run(SES_A, "status");
	assert.match(lastNote(), /身份段 已切除/, "status 反映切除实况");

	await run(SES_A, "mode append");
	const appended = await inject(SES_A);
	assert.ok(appended[0].text.includes("helpful assistant"), "append 人设在最前");
	assert.deepEqual(appended.slice(1), stockSystem(), "append 其余部分一字不动");
	await run(SES_A, "status");
	assert.match(lastNote(), /append 模式不切除/);

	await run(SES_A, "mode strict");
	const strict = await inject(SES_A);
	for (const gone of ["# Harness", "# Communication", "<project_instructions", "OpenCode"]) {
		assert.ok(!joined(strict).includes(gone), `strict 丢掉宿主段: ${gone}`);
	}
	assert.ok(strict.at(-1).text.endsWith("H:/WorkSpace"), "strict 只留 cwd");

	// 5b. ★ 宿主在多步之间可能复用同一个 system 数组：钩子不能原地改它，否则人设会一步叠一份
	const shared = stockSystem();
	for (const mode of ["strict", "replace", "append"]) {
		await run(SES_A, `mode ${mode}`);
		const first = await inject(SES_A, shared);
		const second = await inject(SES_A, shared);
		assert.deepEqual(shared, stockSystem(), `${mode} 不原地修改宿主传入的数组`);
		assert.deepEqual(second, first, `${mode} 连续两步结果一致，人设不叠加`);
		assert.equal(second.filter((part) => part.text.includes("helpful assistant")).length, 1, `${mode} 只有一份人设`);
	}

	// 6. 宿主提示词被替换 / 措辞变了：不能切坏
	await run(SES_A, "mode replace");
	const custom = [{ type: "text", text: "You are my own assistant.\n\nBe brief." }];
	const customOut = await inject(SES_A, custom);
	assert.equal(customOut.length, 2);
	assert.equal(customOut[1].text, "You are my own assistant.\n\nBe brief.", "无身份句时原样保留");
	await run(SES_A, "status");
	assert.match(lastNote(), /身份段 未匹配/, "匹配不到时 status 如实报告");
	// 身份句出现在行中间：说明措辞变了，宁可不切
	const midLine = [{ type: "text", text: "Note: You are an AI agent running in OpenCode, a coding agent harness.\nKeep going." }];
	assert.equal((await inject(SES_A, midLine))[1].text, midLine[0].text, "非行首匹配不切");
	// 身份句独占整段：切完这一段应整个消失，而不是留下空段
	const lonely = [{ type: "text", text: "You are an AI agent running in OpenCode, a coding agent harness." }, { type: "text", text: "tail" }];
	assert.deepEqual((await inject(SES_A, lonely)).slice(1).map((part) => part.text), ["tail"], "空段被丢弃");
	// 缓存提示等附加字段随段保留
	const hinted = [{ type: "text", text: HARNESS_PROMPT, cache: { type: "ephemeral" } }];
	assert.deepEqual((await inject(SES_A, hinted))[1].cache, { type: "ephemeral" }, "replace 保留段上的 cache 字段");

	// 7. 错误的 mode 值不改状态
	await run(SES_A, "mode bogus");
	assert.match(lastNote(), /用法: \/purge mode/);
	assert.match(host.sent.at(-1).text, /^\[pi-purge 错误\]/, "错误带错误标记");
	assert.equal(host.sent.at(-1).metadata.level, "error");
	await run(SES_A, "status");
	assert.match(lastNote(), /模式: replace/, "错误输入不改模式");

	// 8. 换源失败：报错带原因 + 回滚到内嵌
	await run(SES_A, "mode strict");
	await run(SES_A, "source C:/definitely/not/here.md");
	assert.equal(host.sent.at(-1).metadata.level, "error", "不存在的源报错");
	assert.match(lastNote(), /文件不存在/, "错误信息带具体原因");
	assert.ok((await inject(SES_A))[0].text.includes("helpful assistant"), "回滚后仍注入完整内嵌人设");

	// 9. 换成外部文件 → 改文件 → reload → 文件消失
	const personaFile = join(PERSONA_DIR, "persona.md");
	writeFileSync(personaFile, "# Mine\n\nfirst version", "utf8");
	await run(SES_A, `source "${personaFile}"`);
	assert.match(lastNote(), /人设已切换/, "带引号的路径也能识别");
	assert.ok((await inject(SES_A))[0].text.startsWith("# Mine\n\nfirst version"), "注入外部文件正文");
	writeFileSync(personaFile, "# Mine\n\nsecond version", "utf8");
	assert.ok((await inject(SES_A))[0].text.includes("first version"), "没 reload 前仍是旧正文");
	await run(SES_A, "reload");
	assert.match(lastNote(), /已重新读取/);
	assert.ok((await inject(SES_A))[0].text.includes("second version"), "reload 后读到新正文");
	unlinkSync(personaFile);
	await run(SES_A, "reload");
	assert.equal(host.sent.at(-1).metadata.level, "error", "文件消失后 reload 报错");
	assert.deepEqual(await inject(SES_A), stockSystem(), "读不到人设时不改提示词，不会发空人设");

	// 10. 显式切回内嵌
	await run(SES_A, "source embedded");
	assert.match(lastNote(), /人设: 内嵌/, "source embedded 切回内嵌");
	assert.ok((await inject(SES_A))[0].text.includes("helpful assistant"));

	// 11. 空参数是开关；off 后恢复原样
	await run(SES_A, "");
	assert.match(lastNote(), /已关闭/, "已开启时 /purge 等于关闭");
	assert.deepEqual(await inject(SES_A), stockSystem(), "关闭后不再注入，且与未装插件一致");
	await run(SES_A, "");
	assert.match(lastNote(), /已开启/, "已关闭时 /purge 等于开启");
	await run(SES_A, "off");

	// 12. 未知子命令
	await run(SES_A, "frobnicate");
	assert.match(lastNote(), /未知子命令: frobnicate/);

	// 13. ★ 无盘副作用：全程没有任何文件写到 HOME / cwd
	assert.deepEqual(readdirSync(SANDBOX), [], "不写任何状态文件");

	console.log("OK — 13 组断言全部通过");
	console.log("strict 注入后:", strictOn.map((part) => part.text.length), "字符/段");
} finally {
	rmSync(SANDBOX, { recursive: true, force: true });
	rmSync(PERSONA_DIR, { recursive: true, force: true });
}
