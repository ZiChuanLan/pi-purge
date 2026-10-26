/**
 * pi-purge — 会话级系统提示词开关（opencode v2 插件，自带人设，零外部文件依赖）
 *
 * 机制移植自 dsh-purge：宿主身份段不是被压住，而是被**清掉**。
 *  dsh：includeHarnessIdentity -> false、personaPrefix/Suffix -> ""，人设挂头部。
 *  v2 ：strict 模式整段丢弃宿主提示词，只发人设 + 工作目录。
 *
 * 三个设计约束：
 *  1. 默认不启用 —— 不输入 /purge，opencode 与未安装本插件时完全一致。
 *  2. 会话级独立 —— 状态按 sessionID 存在内存里，新会话（含子 agent 会话）都从关闭开始，不落盘。
 *  3. 自带人设 —— 默认用内嵌正文；/purge source <路径> 可换成本地文件。
 *
 * 与 pi 版的对应关系（opencode v2 没有 session_start / before_agent_start / registerCommand）：
 *  before_agent_start -> ctx.session.hook("context")，主 agent 每次请求前改 system
 *  registerCommand    -> ctx.command.transform，命令自带 execute，不会触发模型调用
 *  ctx.ui.notify      -> ctx.session.synthetic({ resume: false })，只记入会话，不唤醒模型
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "@opencode/plugin";

/** 内嵌的示例提示词（默认源）。真用时用 `/purge source <路径>` 换掉。 */
const EMBEDDED_PERSONA = [
	"# Persona (example)",
	"",
	"You are a helpful assistant running inside opencode. Answer the user's request directly",
	"and keep responses concise.",
	"",
	"This text is only a placeholder bundled with pi-purge, so that a fresh install",
	"works immediately: /purge swaps the system prompt for this text plus the working",
	"directory, and /purge off restores opencode's own prompt.",
	"",
	"To run your own instructions instead:",
	"",
	"    /purge source C:/path/to/your-prompt.md",
	"",
	"and /purge source embedded comes back to this example.",
].join("\n");

/** 内嵌源的标识值；也可 `/purge source embedded` 切回来。 */
const EMBEDDED = "embedded";
/** 常见的外部人设位置，仅在用户显式切换时使用。 */
const HINT_SOURCE = join(homedir(), ".dsh", "prompt-inject.md");

type Mode = "strict" | "replace" | "append";
const isMode = (value: unknown): value is Mode => value === "strict" || value === "replace" || value === "append";

/**
 * opencode v2 默认系统提示词（core/src/session/runner/prompt/system.txt）首行的宿主身份句。
 * 子 agent 自带 system 时没有这一句，匹配不到就原样返回。
 */
const HOST_IDENTITY = "You are an AI agent running in OpenCode, a coding agent harness.";

/**
 * 从一段系统提示词里切掉宿主身份行。
 * 用固定文案定位，且必须从行首开始；匹配不到就原样返回 —— opencode 升级改文案时
 * 退化为 append，而不是把整段提示词切坏。
 */
function stripHostIdentity(text: string): { text: string; identity: boolean } {
	const at = text.indexOf(HOST_IDENTITY);
	if (at === -1 || (at > 0 && text[at - 1] !== "\n")) return { text, identity: false };

	const lineEnd = text.indexOf("\n", at);
	const cutEnd = lineEnd === -1 ? text.length : lineEnd + 1;
	const rest = text.slice(0, at) + text.slice(cutEnd);
	return { text: at === 0 ? rest.replace(/^\n+/, "") : rest, identity: true };
}

const textPart = (text: string) => ({ type: "text" as const, text });

interface State {
	enabled: boolean;
	mode: Mode;
	source: string;
	body: string;
	loadError: string;
	// 上一轮实际切除情况，/purge status 用它回答"到底生效了没有"
	lastCut: { mode: Mode; identity: boolean; at: number };
}

function reload(state: State): boolean {
	if (state.source === EMBEDDED) {
		state.body = EMBEDDED_PERSONA;
		state.loadError = "";
		return true;
	}
	try {
		if (!existsSync(state.source)) throw new Error(`文件不存在: ${state.source}`);
		const text = readFileSync(state.source, "utf8").trim();
		if (text.length === 0) throw new Error(`文件为空: ${state.source}`);
		state.body = text;
		state.loadError = "";
		return true;
	} catch (error) {
		state.body = "";
		state.loadError = error instanceof Error ? error.message : String(error);
		return false;
	}
}

/**
 * 新会话的初始 source / mode：插件配置 options 优先，其次 PI_PURGE_SOURCE，否则内嵌示例。
 * 只在 setup 时读一次、不落盘、不自动探测；会话内的 `/purge source|mode` 仍然覆盖它。
 */
function initialSettings(options: Readonly<Record<string, unknown>>): { source: string; mode: Mode } {
	const fromOptions = typeof options.source === "string" ? options.source.trim() : "";
	const fromEnv = process.env.PI_PURGE_SOURCE?.trim() || "";
	return {
		source: fromOptions || fromEnv || EMBEDDED,
		mode: isMode(options.mode) ? options.mode : "strict",
	};
}

const plugin: Plugin.Plugin = {
	id: "pi-purge",
	setup: async (ctx) => {
		const initial = initialSettings(ctx.options);
		const cwd = String(ctx.location.directory).replace(/\\/g, "/");
		// 会话级状态：只活在内存里，按 sessionID 隔离；没有记录就是关闭，插件重载即失，绝不落盘
		const sessions = new Map<string, State>();

		const stateOf = (sessionID: string): State => {
			let state = sessions.get(sessionID);
			if (!state) {
				state = { enabled: false, ...initial, body: "", loadError: "", lastCut: { mode: initial.mode, identity: false, at: 0 } };
				reload(state);
				sessions.set(sessionID, state);
			}
			return state;
		};

		// 只对主 agent 的每次模型请求生效；标题、压缩、generate 走各自的钩子，不受影响
		await ctx.session.hook("context", (event) => {
			const state = sessions.get(event.sessionID);
			if (!state?.enabled || state.body.length === 0) return;

			const persona = textPart(state.body);
			let identity = false;
			const trimmed = event.system.flatMap((part) => {
				const cut = stripHostIdentity(part.text);
				identity ||= cut.identity;
				return cut.text.length > 0 ? [{ ...part, text: cut.text }] : [];
			});

			// 必须整体赋值：宿主读的是这个事件对象上的 system，原数组可能被后续步骤复用，原地改会叠加人设
			if (state.mode === "strict") {
				// 宿主提示词整段丢掉，只留工作目录。工具 schema 走请求的 tools，不依赖这段文字。
				event.system = [persona, textPart(`Current working directory: ${cwd}`)];
			} else if (state.mode === "replace") {
				event.system = [persona, ...trimmed];
			} else {
				event.system = [persona, ...event.system];
			}
			state.lastCut = { mode: state.mode, identity, at: Date.now() };
		});

		await ctx.command.transform((editor) => {
			editor.add({
				name: "purge",
				description: "会话级系统提示词开关：清掉宿主身份段并把人设挂到系统提示词头部",
				execute: async ({ sessionID, prompt }) => {
					const parts = prompt.text.trim().split(/\s+/).filter(Boolean);
					const cmd = (parts[0] ?? "").toLowerCase();
					const arg = parts.slice(1).join(" ").trim();

					const state = stateOf(sessionID);
					// resume: false —— 只把结果记进会话，不唤醒模型；文本会作为用户侧消息留在上下文里
					const notify = async (text: string, level: "info" | "error" = "info") => {
						await ctx.session.synthetic({
							sessionID,
							text: `[pi-purge${level === "error" ? " 错误" : ""}] ${text}`,
							description: "pi-purge",
							metadata: { source: "pi-purge", level },
							resume: false,
						});
					};

					const describe = () => {
						const cut =
							state.lastCut.at === 0
								? "尚未运行过一轮"
								: state.lastCut.mode === "append"
									? "append 模式不切除"
									: `身份段 ${state.lastCut.identity ? "已切除" : "未匹配"}`;
						const modeLabel =
							state.mode === "strict"
								? "strict（只留人设+工作目录）"
								: state.mode === "replace"
									? "replace（清宿主身份段）"
									: "append（只挂头部）";
						return [
							`状态: ${state.enabled ? "开启" : "关闭"}（仅本会话）`,
							`模式: ${modeLabel}`,
							`人设: ${state.source === EMBEDDED ? "内嵌" : state.source}${state.body.length > 0 ? `  ${state.body.length} 字符` : `  未加载${state.loadError ? `（${state.loadError}）` : ""}`}`,
							`上轮切除: ${cut}`,
						].join("\n");
					};

					const turnOn = () => {
						if (!reload(state)) return notify(`无法开启：${state.loadError}`, "error");
						state.enabled = true;
						return notify(`已开启（${state.mode}，仅本会话），每轮注入 ${state.body.length} 字符。\n${describe()}`);
					};

					const turnOff = () => {
						state.enabled = false;
						return notify("已关闭，恢复 opencode 原始系统提示词。");
					};

					switch (cmd) {
						case "":
							return state.enabled ? turnOff() : turnOn();
						case "on":
						case "enable":
							return turnOn();
						case "off":
						case "disable":
							return turnOff();
						case "status":
							return notify(describe());
						case "reload": {
							if (!reload(state)) return notify(`重新读取失败：${state.loadError}`, "error");
							return notify(`已重新读取，正文 ${state.body.length} 字符。\n${describe()}`);
						}
						case "mode": {
							const wanted = arg.toLowerCase();
							if (!isMode(wanted)) {
								return notify(
									`当前模式: ${state.mode}\n用法: /purge mode strict|replace|append\nstrict  = 只发人设 + 工作目录（隔离最彻底）\nreplace = 清 opencode 身份段\nappend  = 只把人设挂头部`,
									"error",
								);
							}
							state.mode = wanted;
							return notify(`模式已切换为 ${wanted}（仅本会话）。\n${describe()}`);
						}
						case "source": {
							if (!arg) {
								return notify(
									`当前人设: ${state.source === EMBEDDED ? "内嵌" : state.source}\n用法: /purge source <绝对路径|embedded>\n提示: 常见外部位置 ${HINT_SOURCE}`,
									"error",
								);
							}
							const previous = state.source;
							state.source = arg.replace(/^["']|["']$/g, "");
							if (state.source.toLowerCase() === EMBEDDED) state.source = EMBEDDED;
							if (!reload(state)) {
								// 回滚会清掉 loadError，先存下来再恢复，否则报错信息变成空
								const reason = state.loadError;
								state.source = previous;
								reload(state);
								return notify(`切换失败：${reason}`, "error");
							}
							return notify(`人设已切换，正文 ${state.body.length} 字符。\n${describe()}`);
						}
						default:
							return notify(`未知子命令: ${cmd}\n用法: /purge [on|off|status|reload|mode|source]`);
					}
				},
			});
		});
	},
};

export default plugin;
