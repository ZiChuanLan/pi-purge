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

/**
 * pi 默认提示词里的宿主身份句（dist/core/system-prompt.js 的 preamble 首句）。
 * 措辞随 pi 版本变过，按"新在前"排列，逐个试；都落空再走下面的模板兜底。
 *   ≤1.4.x: "You are an expert coding assistant operating inside pi, ..."
 *   ≥1.5.2: "You are a coding assistant running inside pi, ..."
 */
const HOST_IDENTITY_LINES = [
	"You are a coding assistant running inside pi, a coding agent harness.",
	"You are an expert coding assistant operating inside pi, a coding agent harness.",
];
/** 模板兜底：只认单行、以 harness 句收尾（同一行后面还可能跟别的句子）。 */
const HOST_IDENTITY_RE = /^You are an? \S[^\n]{0,160}?coding agent harness\./m;

/**
 * pi 文档段的边界。pi ≥1.5.2 把各段包进 <docs>…</docs>，用标签最稳；
 * 更早的版本是裸文本，退回到固定文案（起点一致，终点两代各一条）。
 * 任一锚点匹配不到就整段跳过，绝不猜边界。
 */
const HOST_DOCS_TAGS = ["<docs>", "</docs>"];
const HOST_DOCS_START = "Pi documentation (read only when the user asks about ";
const HOST_DOCS_ENDS = ["following related cross-references.", "(e.g., tui.md for TUI API details)"];

/**
 * pi 的 before_agent_start 给 string，omp 给 string[]；统一成一块文本。
 * 直接拼接数组会走 Array.toString()，把每段之间变成逗号。
 */
function systemText(value: unknown): string {
	if (Array.isArray(value)) return value.filter((block): block is string => typeof block === "string").join("\n\n");
	return typeof value === "string" ? value : "";
}

/** 从 startAt 所在行的行首切到 endMarker 所在行的行尾；标记缺失返回 null。 */
function dropThroughLine(text: string, startAt: number, endMarker: string, from: number): string | null {
	const endAt = text.indexOf(endMarker, from);
	if (endAt === -1) return null;
	let start = startAt;
	while (start > 0 && text[start - 1] === "\n") start -= 1;
	const lineEnd = text.indexOf("\n", endAt + endMarker.length);
	const end = lineEnd === -1 ? text.length : lineEnd + 1;
	return text.slice(0, start) + text.slice(end);
}

/** 切掉宿主身份句：先试历史措辞，再用模板兜底。都落空就原样返回。 */
function stripIdentityLine(text: string): { text: string; found: boolean } {
	let at = -1;
	for (const line of HOST_IDENTITY_LINES) {
		at = text.indexOf(line);
		if (at !== -1) break;
	}
	if (at === -1) {
		const match = HOST_IDENTITY_RE.exec(text);
		at = match?.index ?? -1;
	}
	if (at === -1) return { text, found: false };
	const lineEnd = text.indexOf("\n", at);
	const cutEnd = lineEnd === -1 ? text.length : lineEnd + 1;
	return { text: text.slice(0, at) + text.slice(cutEnd), found: true };
}

/** 切掉 pi 文档段：<docs> 标签优先，退回固定文案。匹配不到原样返回。 */
function stripDocsBlock(text: string): { text: string; found: boolean } {
	const [open, close] = HOST_DOCS_TAGS;
	const tagAt = text.indexOf(open);
	if (tagAt !== -1) {
		const cut = dropThroughLine(text, tagAt, close, tagAt + open.length);
		if (cut !== null) return { text: cut, found: true };
	}

	const docsAt = text.indexOf(HOST_DOCS_START);
	if (docsAt !== -1) {
		for (const endMarker of HOST_DOCS_ENDS) {
			const cut = dropThroughLine(text, docsAt, endMarker, docsAt + HOST_DOCS_START.length);
			if (cut !== null) return { text: cut, found: true };
		}
	}

	return { text, found: false };
}

/**
 * 从系统提示词里切掉宿主身份句和 pi 文档段。
 * 锚点覆盖 pi ≤1.4 与 ≥1.5.2 两代文案，仍匹配不到就原样返回 ——
 * pi 升级再改措辞时退化为 append，而不是把整段提示词切坏。
 */
function stripHostPersona(systemPrompt: string): { text: string; identity: boolean; docs: boolean } {
	const identity = stripIdentityLine(systemPrompt);
	const docs = stripDocsBlock(identity.text);
	return { text: docs.text, identity: identity.found, docs: docs.found };
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

		const hostText = systemText(event.systemPrompt);
		let host = hostText;
		if (mode === "strict") {
			// 等价 dsh 的 strict baseline：宿主提示词整段丢掉，只留工作目录。
			// 工具 schema 走 API 的 tools 参数，不依赖这段文字。
			// omp 的事件不带 systemPromptOptions，用进程 cwd 兜底。
			const cwd = event.systemPromptOptions?.cwd ?? process.cwd();
			host = cwd ? `Current working directory: ${String(cwd).replace(/\\/g, "/")}` : "";
			const cut = stripHostPersona(hostText);
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
			["on", "off", "status", "mode", "source", "reload"]
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
				case "reload": {
					// 只重读正文，不改开关状态：改完外部文件想立刻生效用这个
					if (!reload()) return notify(`重新读取失败：${loadError}`, "error");
					return notify(`已重新读取。\n${describe()}`);
				}
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
					return notify(`未知子命令: ${cmd}\n用法: /purge [on|off|status|mode|source|reload]`);
			}
		},
	});
}
