import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// 独立的临时 agent 目录：仍然断言本扩展不写任何状态文件
const AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-purge-env-test-"));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;

// 默认源在模块加载时求值，所以必须在 import 之前设置
const SOURCE_DIR = mkdtempSync(join(tmpdir(), "pi-purge-env-src-"));
const SOURCE_FILE = join(SOURCE_DIR, "persona.md");
const SOURCE_BODY = "# Env persona\n\nLoaded from PI_PURGE_SOURCE.";
writeFileSync(SOURCE_FILE, SOURCE_BODY, "utf8");
process.env.PI_PURGE_SOURCE = SOURCE_FILE;

const events = new Map();
const commands = new Map();
const notes = [];
const statuses = [];

const pi = {
	on: (name, handler) => events.set(name, handler),
	registerCommand: (name, options) => commands.set(name, options),
};

const mod = await import(pathToFileURL(join(import.meta.dirname, "..", "extensions", "pi-purge.ts")).href);
mod.default(pi);

const ctx = {
	ui: {
		setStatus: (key, text) => statuses.push(text),
		notify: (text, level) => notes.push([level ?? "info", text]),
	},
};
const cmd = commands.get("purge");
const before = events.get("before_agent_start");
const start = events.get("session_start");
const lastNote = () => notes.at(-1)?.[1] ?? "";
const inject = (cwd = "H:\\WorkSpace") => before({ systemPrompt: "HOST PROMPT", systemPromptOptions: { cwd } }, ctx);

try {
	// 1. 仍然是默认关闭，但默认源已经变成 PI_PURGE_SOURCE
	await start({ reason: "startup" }, ctx);
	assert.equal(await inject(), undefined, "默认关闭时不注入");
	await cmd.handler("status", ctx);
	assert.match(lastNote(), /状态: 关闭/, "启动仍然默认关闭");
	assert.ok(lastNote().includes(SOURCE_FILE), "status 显示 PI_PURGE_SOURCE 的路径");
	assert.ok(lastNote().includes(`${SOURCE_BODY.length} 字符`), "status 显示该文件的字符数");

	// 2. /purge on 直接使用环境变量指向的正文
	await cmd.handler("on", ctx);
	const sp = (await inject()).systemPrompt;
	assert.ok(sp.startsWith("# Env persona"), "注入 PI_PURGE_SOURCE 指向的正文");
	assert.ok(!sp.includes("HOST PROMPT"), "strict 仍丢弃宿主提示词");
	assert.ok(sp.endsWith("Current working directory: H:/WorkSpace"), "strict 仍只追加 cwd");
	assert.ok(!sp.includes("helpful assistant"), "没有回退到内嵌示例");

	// 3. 显式 /purge source 仍然优先于环境变量
	await cmd.handler("source embedded", ctx);
	await cmd.handler("on", ctx);
	const embedded = (await inject()).systemPrompt;
	assert.ok(embedded.includes("helpful assistant"), "/purge source embedded 覆盖 PI_PURGE_SOURCE");

	// 4. 仍然不写盘
	assert.deepEqual(readdirSync(AGENT_DIR), [], "不写任何状态文件");

	console.log("OK — PI_PURGE_SOURCE 断言通过");
} finally {
	rmSync(AGENT_DIR, { recursive: true, force: true });
	rmSync(SOURCE_DIR, { recursive: true, force: true });
}
