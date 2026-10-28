import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// 0.2 起扩展不写任何状态文件；仍然隔离 agent dir，用来证明「跑完目录还是空的」
const AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-purge-test-"));
process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
// 默认源在模块加载时求值：清掉 shell 里可能导出的 PI_PURGE_SOURCE，保证本套件跑内嵌源
delete process.env.PI_PURGE_SOURCE;

// pi dist/core/system-prompt.js buildSystemPrompt() 的真实输出形态
const REAL_PI_PROMPT = `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
- read: Read file contents with line numbers
- bash: Run shell commands

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
- Be concise in your responses

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: C:/pi/README.md
- Additional docs: C:/pi/docs
- Examples: C:/pi/examples (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md)
- When working on pi topics, read the docs and examples
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)

<project_context>

Project-specific instructions and guidelines:

<project_instructions path="C:/AGENTS.md">
# Rules
</project_instructions>

</project_context>

Current working directory: H:/WorkSpace`;

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
const inject = (prompt = REAL_PI_PROMPT, cwd = "H:\\WorkSpace") => before({ systemPrompt: prompt, systemPromptOptions: { cwd } }, ctx);

try {
	// 1. 内嵌人设：不需要任何外部文件就能开
	await start({ reason: "startup" }, ctx);
	assert.equal(await inject(), undefined, "默认关闭，不碰系统提示词");
	await cmd.handler("status", ctx);
	assert.match(lastNote(), /人设: 内嵌/, "默认人设来自内嵌常量");
	assert.match(lastNote(), /状态: 关闭/);
	assert.match(lastNote(), /仅本会话/);

	await cmd.handler("on", ctx);
	assert.equal(statuses.at(-1), "PURGE ON", "footer 显示 PURGE ON");
	const sp = (await inject()).systemPrompt;
	assert.ok(sp.includes("helpful assistant"), "内嵌人设已注入");
	assert.ok(sp.endsWith("Current working directory: H:/WorkSpace"), "strict 保留工作目录");
	assert.ok(!sp.includes("You are an expert coding assistant"), "strict 丢掉宿主身份句");
	assert.ok(!sp.includes("Available tools:"), "strict 丢掉宿主结构");

	// 2. ★ 会话级独立：新会话必须归零
	await start({ reason: "new" }, ctx);
	assert.equal(statuses.at(-1), undefined, "新会话 footer 清空状态");
	assert.equal(await inject(), undefined, "新会话不继承上一会话的开启状态");

	// 3. ★ resume 同样归零：状态不落盘，退出即失
	await cmd.handler("on", ctx);
	await start({ reason: "resume" }, ctx);
	assert.equal(await inject(), undefined, "resume 也不继承");

	// 4. 三种模式
	await cmd.handler("on", ctx);

	await cmd.handler("mode replace", ctx);
	const replaced = (await inject()).systemPrompt;
	assert.ok(!replaced.includes("You are an expert coding assistant"), "replace 切除身份句");
	assert.ok(!replaced.includes("Pi documentation (read only"), "replace 切除文档段");
	for (const keep of ["Available tools:", "- Be concise in your responses", "<project_context>", "<project_instructions"]) {
		assert.ok(replaced.includes(keep), `replace 保留宿主结构: ${keep}`);
	}
	await cmd.handler("status", ctx);
	assert.match(lastNote(), /身份段 已切除 \/ pi 文档段 已切除/, "status 反映切除实况");

	await cmd.handler("mode append", ctx);
	const appended = (await inject()).systemPrompt;
	assert.ok(appended.includes("You are an expert coding assistant"), "append 不动宿主身份句");
	assert.ok(appended.includes("Pi documentation (read only"), "append 不动文档段");
	assert.ok(appended.includes("<project_context>"), "append 不动项目上下文");

	// omp 的 systemPrompt 是 string[]：拼接结果不能变成逗号串
	const omp = (await before({ systemPrompt: ["HOST IDENTITY", "SECOND BLOCK"], systemPromptOptions: { cwd: "H:/WorkSpace" } }, ctx)).systemPrompt;
	assert.ok(omp.includes("HOST IDENTITY\n\nSECOND BLOCK"), "omp 数组按块拼接，不用逗号");
	assert.ok(!omp.includes("HOST IDENTITY,SECOND BLOCK"), "omp 数组不得退化为逗号串");

	await cmd.handler("mode strict", ctx);
	const strict = (await inject()).systemPrompt;
	for (const gone of ["Available tools:", "Guidelines:", "<project_context>", "Pi documentation"]) {
		assert.ok(!strict.includes(gone), `strict 丢掉宿主段: ${gone}`);
	}
	assert.ok(strict.endsWith("Current working directory: H:/WorkSpace"), "strict 只留 cwd");

	// omp 事件不带 cwd：退回进程工作目录，而不是丢掉 strict 的 cwd
	const ompStrict = (await before({ systemPrompt: ["HOST IDENTITY"] }, ctx)).systemPrompt;
	assert.ok(ompStrict.endsWith(`Current working directory: ${process.cwd().replace(/\\/g, "/")}`), "omp 无 cwd 时用 process.cwd() 兜底");

	// 5. 换源失败：报错带原因 + 回滚到内嵌
	await cmd.handler("source C:/definitely/not/here.md", ctx);
	assert.equal(notes.at(-1)[0], "error", "不存在的源报 error");
	assert.match(lastNote(), /文件不存在/, "错误信息带具体原因");
	const afterFail = (await inject()).systemPrompt;
	assert.ok(afterFail.includes("helpful assistant"), "回滚后仍注入完整内嵌人设");

	// 6. 显式切回内嵌
	await cmd.handler("source embedded", ctx);
	assert.match(lastNote(), /人设: 内嵌/, "source embedded 切回内嵌");

	// 7. 自定义 SYSTEM.md（没有身份句/文档段）不能切坏
	const custom = "You are my own assistant.\n\nCurrent working directory: H:/WorkSpace";
	await cmd.handler("mode append", ctx);
	const customOut = (await inject(custom)).systemPrompt;
	assert.ok(customOut.includes("You are my own assistant."), "无身份句时原样保留");

	// 8. off
	await cmd.handler("off", ctx);
	assert.equal(await inject(), undefined, "关闭后不再注入");
	assert.equal(statuses.at(-1), undefined, "footer 清空");

	// 9. ★ 无盘副作用：全程没写状态文件
	assert.deepEqual(readdirSync(AGENT_DIR), [], "不写任何状态文件");

	console.log("OK — 9 组断言全部通过");
	console.log("内嵌人设注入后:", sp.length, "字符");
} finally {
	rmSync(AGENT_DIR, { recursive: true, force: true });
}
