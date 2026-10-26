import { join } from "node:path";
import { pathToFileURL } from "node:url";

// opencode v2.1.4 默认系统提示词（core/src/session/runner/prompt/system.txt）的真实文案，
// ${OPENCODE_TOOL_GUIDANCE} 已按 session/system-prompt.ts 的规则渲染（只带 shell 一条）。
export const HARNESS_PROMPT = `You are an AI agent running in OpenCode, a coding agent harness. Help the user accomplish their goals using the tools you have available.

# Harness
- Responses are rendered as GitHub-flavored Markdown.
- \`<system-reminder>\` blocks are harness instructions, not user-authored content. Read and follow them.
- Prefer parallelizing independent tool calls.
- Prefer dedicated tools over shell commands; fall back to the shell when a tool cannot do what you need.

# Communication
- Use clear file paths when referring to files.
- Keep responses clear and concise, and avoid unnecessary technical jargon.

# Working in codebases
- Keep changes consistent with the structure, naming, style, and patterns of the surrounding code.
- Treat unfamiliar files or changes as potential user work and investigate before deleting or overwriting them.`;

// 第二段（项目上下文等）的具体文案由宿主决定，这里只是一段有代表性的占位：
// 断言只关心 replace / append 不去动它、strict 会丢掉它。
export const INITIAL_CONTEXT = `<project_instructions path="H:/WorkSpace/AGENTS.md">
# Rules
</project_instructions>`;

export const DIRECTORY = "H:\\WorkSpace";

export const stockSystem = () => [
	{ type: "text", text: HARNESS_PROMPT },
	{ type: "text", text: INITIAL_CONTEXT },
];

const mod = await import(pathToFileURL(join(import.meta.dirname, "..", "index.ts")).href);

/**
 * 一个最小的 opencode v2 宿主：只实现插件用到的 ctx.session.hook / synthetic、
 * ctx.command.transform、ctx.location、ctx.options。每次调用都是一次全新的 setup。
 */
export async function createHost({ options = {}, directory = DIRECTORY } = {}) {
	const hooks = new Map();
	const commands = new Map();
	const sent = [];

	const ctx = {
		options,
		location: { directory },
		session: {
			hook: async (name, callback) => {
				hooks.set(name, callback);
				return { dispose: async () => {} };
			},
			synthetic: async (input) => {
				sent.push(input);
				return { id: `msg_${sent.length}` };
			},
		},
		command: {
			transform: async (callback) => {
				callback({ add: (definition) => commands.set(definition.name, definition) });
				return { dispose: async () => {} };
			},
		},
	};
	await mod.default.setup(ctx);

	const purge = commands.get("purge");
	return {
		plugin: mod.default,
		commands,
		hooks,
		sent,
		lastNote: () => sent.at(-1)?.text ?? "",
		run: (sessionID, text = "") => purge.execute({ sessionID, prompt: { text }, delivery: "steer" }),
		// 模拟一次主 agent 的模型请求，返回钩子处理后的 system
		inject: async (sessionID, system = stockSystem()) => {
			const event = { sessionID, agent: "build", model: {}, system, messages: [], options: {}, tools: {} };
			await hooks.get("context")(event);
			return event.system;
		},
	};
}
