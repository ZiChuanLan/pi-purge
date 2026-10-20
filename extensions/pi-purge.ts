/**
 * pi-purge — 会话级破限开关（自带人设，零外部文件依赖）
 *
 * 机制移植自 dsh-purge：宿主身份段不是被压住，而是被**清掉**。
 *  dsh：includeHarnessIdentity -> false、personaPrefix/Suffix -> ""，人设挂头部。
 *  pi ：strict 模式整段丢弃宿主提示词，只发人设 + 工作目录。
 *
 * 三个设计约束：
 *  1. 默认不启用 —— 不输入 /purge，pi 与未安装本扩展时完全一致。
 *  2. 会话级独立 —— 状态只在内存里，每次 session_start 归零，退出即失，不落盘。
 *  3. 自带人设 —— 默认用内嵌正文；/purge source <路径> 可换成本地文件。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 内嵌的示例提示词（默认源）。真用时用 `/purge source <路径>` 换掉。 */
const EMBEDDED_PERSONA = [
	"# Persona (example)",
	"",
	"You are a helpful assistant running inside pi. Answer the user's request directly",
	"and keep responses concise.",
	"",
	"This text is only a placeholder bundled with pi-purge, so that a fresh install",
	"works immediately: /purge swaps the system prompt for this text plus the working",
	"directory, and /purge off restores pi's own prompt.",
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

/**
 * 默认源的初始值：由 PI_PURGE_SOURCE 显式指定绝对路径，未设置时保持内嵌示例。
 * 只读一次、不落盘、不自动探测；进程内的 `/purge source` 仍然覆盖它。
 */
const ENV_SOURCE = process.env.PI_PURGE_SOURCE?.trim() || "";

type Mode = "strict" | "replace" | "append";

// 会话级状态：只活在内存里，pi 退出即失，绝不跨会话 / 跨进程泄漏
let enabled = false;
let mode: Mode = "strict";
let source = ENV_SOURCE || EMBEDDED;
let body = EMBEDDED_PERSONA;
let loadError = "";
// 上一轮实际切除情况，/purge status 用它回答"到底生效了没有"
let lastCut = { identity: false, docs: false, at: 0 };

/** pi 默认提示词里的宿主身份句（dist/core/system-prompt.js 模板首句）。 */
const HOST_IDENTITY = "You are an expert coding assistant operating inside pi, a coding agent harness.";
/** pi 文档段的起点与终点标记；任一处匹配不到就整段跳过，绝不猜边界。 */
const HOST_DOCS_START = "Pi documentation (read only when the user asks about pi itself";
const HOST_DOCS_END = "(e.g., tui.md for TUI API details)";

/**
 * 从系统提示词里切掉宿主身份句和 pi 文档段。
 * 两处都用固定文案定位，匹配不到就原样返回 —— pi 升级改文案时退化为 append，
 * 而不是把整段提示词切坏。
 */
function stripHostPersona(systemPrompt: string): { text: string; identity: boolean; docs: boolean } {
	let text = systemPrompt;
	let identity = false;
	let docs = false;

	const identityAt = text.indexOf(HOST_IDENTITY);
	if (identityAt !== -1) {
		const lineEnd = text.indexOf("\n", identityAt);
		const cutEnd = lineEnd === -1 ? text.length : lineEnd + 1;
		text = text.slice(0, identityAt) + text.slice(cutEnd);
		identity = true;
	}

	const docsAt = text.indexOf(HOST_DOCS_START);
	if (docsAt !== -1) {
		const docsEndAt = text.indexOf(HOST_DOCS_END, docsAt + HOST_DOCS_START.length);
		if (docsEndAt !== -1) {
			let start = docsAt;
			while (start > 0 && text[start - 1] === "\n") start -= 1;
			const lineEnd = text.indexOf("\n", docsEndAt);
			const end = lineEnd === -1 ? text.length : lineEnd + 1;
			text = text.slice(0, start) + text.slice(end);
			docs = true;
		}
	}

	return { text, identity, docs };
}

export default function piPurge(pi: ExtensionAPI) {
	const reload = (): boolean => {
		if (source === EMBEDDED) {
			body = EMBEDDED_PERSONA;
			loadError = body.length > 0 ? "" : "内嵌人设为空";
			return body.length > 0;
		}
		try {
			if (!existsSync(source)) throw new Error(`文件不存在: ${source}`);
			const text = readFileSync(source, "utf8").trim();
			if (text.length === 0) throw new Error(`文件为空: ${source}`);
			body = text;
			loadError = "";
			return true;
		} catch (error) {
			body = "";
			loadError = error instanceof Error ? error.message : String(error);
			return false;
		}
	};

	const paint = (ctx: { ui?: { setStatus?: (key: string, text?: string) => void } }) => {
		// -p / --mode json 没有 footer，setStatus 不能把会话搞挂
		try {
			ctx.ui?.setStatus?.("pi-purge", enabled ? "PURGE ON" : undefined);
		} catch {
			/* 非交互模式忽略 */
		}
	};

	// 每个会话独立：新会话 / 恢复会话 / 热重载都从"关闭"开始
	pi.on("session_start", async (_event, ctx) => {
		enabled = false;
		lastCut = { identity: false, docs: false, at: 0 };
		reload();
		paint(ctx);
	});

	pi.on("before_agent_start", async (event) => {
		if (!enabled || body.length === 0) return;

		let host = event.systemPrompt;
		if (mode === "strict") {
			// 等价 dsh 的 strict baseline：宿主提示词整段丢掉，只留工作目录。
			// 工具 schema 走 API 的 tools 参数，不依赖这段文字。
			const cwd = event.systemPromptOptions?.cwd;
			host = cwd ? `Current working directory: ${String(cwd).replace(/\\/g, "/")}` : "";
			const cut = stripHostPersona(event.systemPrompt);
			lastCut = { identity: cut.identity, docs: cut.docs, at: Date.now() };
		} else if (mode === "replace") {
			const cut = stripHostPersona(host);
			host = cut.text;
			lastCut = { identity: cut.identity, docs: cut.docs, at: Date.now() };
		}
		return { systemPrompt: host.length > 0 ? `${body}\n\n${host}` : body };
	});

	pi.registerCommand("purge", {
		description: "会话级破限开关：清掉宿主身份段并把人设挂到系统提示词头部",
		getArgumentCompletions: (prefix: string) =>
			["on", "off", "status", "mode", "source"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value })),
		handler: async (args: string, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const cmd = (parts[0] ?? "").toLowerCase();
			const arg = parts.slice(1).join(" ").trim();

			const notify = (text: string, level: "info" | "error" = "info") => ctx.ui.notify(text, level);

			if ((cmd === "status" || cmd === "") && body.length === 0) reload();

			const describe = () => {
				const cut =
					lastCut.at === 0
						? "尚未运行过一轮"
						: `身份段 ${lastCut.identity ? "已切除" : "未匹配"} / pi 文档段 ${lastCut.docs ? "已切除" : "未匹配"}`;
				const modeLabel =
					mode === "strict" ? "strict（只留人设+工作目录）" : mode === "replace" ? "replace（清宿主身份段）" : "append（只挂头部）";
				return [
					`状态: ${enabled ? "开启" : "关闭"}（仅本会话）`,
					`模式: ${modeLabel}`,
					`人设: ${source === EMBEDDED ? "内嵌" : source}${body.length > 0 ? `  ${body.length} 字符` : `  未加载${loadError ? `（${loadError}）` : ""}`}`,
					`上轮切除: ${cut}`,
				].join("\n");
			};

			const turnOn = () => {
				if (!reload()) return notify(`无法开启：${loadError}`, "error");
				enabled = true;
				paint(ctx);
				notify(`已开启（${mode}，仅本会话），每轮注入 ${body.length} 字符。\n${describe()}`);
			};

			const turnOff = () => {
				enabled = false;
				paint(ctx);
				notify("已关闭，恢复 pi 原始系统提示词。");
			};

			switch (cmd) {
				case "":
					if (enabled) turnOff();
					else turnOn();
					return;
				case "on":
				case "enable":
					return turnOn();
				case "off":
				case "disable":
					return turnOff();
				case "status":
					return notify(describe());
				case "mode": {
					const wanted = arg.toLowerCase();
					if (wanted !== "strict" && wanted !== "replace" && wanted !== "append") {
						return notify(
							`当前模式: ${mode}\n用法: /purge mode strict|replace|append\nstrict  = 只发人设 + 工作目录（破限最彻底）\nreplace = 清 pi 身份段与文档段\nappend  = 只把人设挂头部`,
							"error",
						);
					}
					mode = wanted as Mode;
					return notify(`模式已切换为 ${wanted}（仅本会话）。\n${describe()}`);
				}
				case "source": {
					if (!arg) {
						return notify(
							`当前人设: ${source === EMBEDDED ? "内嵌" : source}\n用法: /purge source <绝对路径|embedded>\n提示: 常见外部位置 ${HINT_SOURCE}`,
							"error",
						);
					}
					const previous = source;
					source = arg.replace(/^["']|["']$/g, "");
					if (source.toLowerCase() === EMBEDDED) source = EMBEDDED;
					if (!reload()) {
						// 回滚会清掉 loadError，先存下来再恢复，否则报错信息变成空
						const reason = loadError;
						source = previous;
						reload();
						return notify(`切换失败：${reason}`, "error");
					}
					return notify(`人设已切换，正文 ${body.length} 字符。\n${describe()}`);
				}
				default:
					return notify(`未知子命令: ${cmd}\n用法: /purge [on|off|status|mode|source]`);
			}
		},
	});
}
