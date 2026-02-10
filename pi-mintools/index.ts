/**
 * Minimal Mode Example - Demonstrates a "minimal" tool display mode
 *
 * This extension overrides built-in tools to provide custom rendering:
 * - Minimal mode: Collapsed view shows little/no output
 * - Default-style mode: Shows compact preview output
 * - Expanded mode (Ctrl+O): Shows full output in both modes
 *
 * Shortcut:
 * - Ctrl+Alt+O toggles Minimal mode <-> Default-style mode
 *
 * Flags:
 * - --mintools-bash=true to opt-in to the pi-mintools bash override
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	keyHint,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { homedir } from "os";

const TOGGLE_RENDER_MODE_SHORTCUT = "ctrl+alt+o";

/**
 * Shorten a path by replacing home directory with ~
 */
function shortenPath(path: string): string {
	const home = homedir();
	if (path.startsWith(home)) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

function getTextContent(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text || "")
		.join("\n");
}

function renderOutput(
	text: string,
	expanded: boolean,
	theme: any,
	options?: {
		collapsedLines?: number;
		color?: "toolOutput" | "error";
		tail?: boolean;
	},
): Text {
	if (!text.trim()) return new Text("", 0, 0);

	const color = options?.color ?? "toolOutput";
	const collapsedLines = options?.collapsedLines ?? 10;
	const lines = text.split("\n");
	const maxLines = expanded ? lines.length : collapsedLines;
	const visible = options?.tail && !expanded ? lines.slice(-maxLines) : lines.slice(0, maxLines);
	const remaining = lines.length - visible.length;

	let output = visible.map((line) => theme.fg(color, line)).join("\n");
	if (!expanded && remaining > 0) {
		output += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("expandTools", "to expand")})`;
	}

	return new Text(`\n${output}`, 0, 0);
}

// Cache for built-in tools by cwd
const toolCache = new Map<string, ReturnType<typeof createBuiltInTools>>();

function createBuiltInTools(cwd: string) {
	return {
		read: createReadTool(cwd),
		bash: createBashTool(cwd),
		edit: createEditTool(cwd),
		write: createWriteTool(cwd),
	};
}

function getBuiltInTools(cwd: string) {
	let tools = toolCache.get(cwd);
	if (!tools) {
		tools = createBuiltInTools(cwd);
		toolCache.set(cwd, tools);
	}
	return tools;
}

function isTruthyFlag(value: unknown): boolean {
	if (value === true) return true;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
	}
	return false;
}

export default function (pi: ExtensionAPI) {
	let defaultStyleMode = false;

	const BASH_FLAG = "mintools-bash";
	pi.registerFlag(BASH_FLAG, {
		description: "Enable pi-mintools bash tool override",
		type: "boolean",
		default: false,
	});
	const bashToolEnabled = isTruthyFlag(pi.getFlag(`--${BASH_FLAG}`));

	const bashCustomRenderCall = (args: any, theme: any) => {
		const command = args.command || "...";
		const timeout = args.timeout as number | undefined;
		const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
		return new Text(theme.fg("toolTitle", theme.bold(`$ ${command}`)) + timeoutSuffix, 0, 0);
	};

	const bashCustomRenderResult = (result: any, { expanded }: { expanded: boolean }, theme: any) => {
		if (!defaultStyleMode && !expanded) {
			return new Text("", 0, 0);
		}
		return renderOutput(getTextContent(result as any).trim(), expanded, theme, {
			collapsedLines: 5,
			tail: true,
		});
	};

	const readCustomRenderCall = (args: any, theme: any) => {
		const path = shortenPath(args.path || "");
		let pathDisplay = path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");

		if (args.offset !== undefined || args.limit !== undefined) {
			const startLine = args.offset ?? 1;
			const endLine = args.limit !== undefined ? startLine + args.limit - 1 : "";
			pathDisplay += theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
		}

		return new Text(`${theme.fg("toolTitle", theme.bold("read"))} ${pathDisplay}`, 0, 0);
	};

	const readCustomRenderResult = (result: any, { expanded }: { expanded: boolean }, theme: any) => {
		if (!defaultStyleMode && !expanded) {
			return new Text("", 0, 0);
		}
		return renderOutput(getTextContent(result as any), expanded, theme, { collapsedLines: 10 });
	};

	const writeCustomRenderCall = (args: any, theme: any) => {
		const path = shortenPath(args.path || "");
		const pathDisplay = path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");
		const lineCount = args.content ? args.content.split("\n").length : 0;
		const lineInfo = lineCount > 0 ? theme.fg("muted", ` (${lineCount} lines)`) : "";

		return new Text(`${theme.fg("toolTitle", theme.bold("write"))} ${pathDisplay}${lineInfo}`, 0, 0);
	};

	const writeCustomRenderResult = (result: any, { expanded }: { expanded: boolean }, theme: any) => {
		if (!defaultStyleMode && !expanded) {
			return new Text("", 0, 0);
		}

		const text = getTextContent(result as any);
		if (!text) return new Text("", 0, 0);

		const isError = text.includes("Error") || text.includes("error");
		return renderOutput(text, expanded, theme, {
			collapsedLines: 10,
			color: isError ? "error" : "toolOutput",
		});
	};

	const editCustomRenderCall = (args: any, theme: any) => {
		const path = shortenPath(args.path || "");
		const pathDisplay = path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");
		return new Text(`${theme.fg("toolTitle", theme.bold("edit"))} ${pathDisplay}`, 0, 0);
	};

	const editCustomRenderResult = (result: any, { expanded }: { expanded: boolean }, theme: any) => {
		if (!defaultStyleMode && !expanded) {
			return new Text("", 0, 0);
		}

		const text = getTextContent(result as any);
		if (!text) return new Text("", 0, 0);

		const isError = text.includes("Error") || text.includes("error");
		return renderOutput(text, expanded, theme, {
			collapsedLines: 15,
			color: isError ? "error" : "toolOutput",
		});
	};

	const readTool: any = {
		name: "read",
		label: "read",
		description:
			"Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files.",
		parameters: getBuiltInTools(process.cwd()).read.parameters,

		async execute(toolCallId: string, params: any, signal: AbortSignal, onUpdate: any, ctx: any) {
			const tools = getBuiltInTools(ctx.cwd);
			return tools.read.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall: readCustomRenderCall,
		renderResult: readCustomRenderResult,
	};

	const bashTool: any = {
		name: "bash",
		label: "bash",
		description:
			"Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first).",
		parameters: getBuiltInTools(process.cwd()).bash.parameters,

		async execute(toolCallId: string, params: any, signal: AbortSignal, onUpdate: any, ctx: any) {
			const tools = getBuiltInTools(ctx.cwd);
			return tools.bash.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall: bashCustomRenderCall,
		renderResult: bashCustomRenderResult,
	};

	const writeTool: any = {
		name: "write",
		label: "write",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		parameters: getBuiltInTools(process.cwd()).write.parameters,

		async execute(toolCallId: string, params: any, signal: AbortSignal, onUpdate: any, ctx: any) {
			const tools = getBuiltInTools(ctx.cwd);
			return tools.write.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall: writeCustomRenderCall,
		renderResult: writeCustomRenderResult,
	};

	const editTool: any = {
		name: "edit",
		label: "edit",
		description:
			"Edit a file by replacing exact text. The oldText must match exactly (including whitespace). Use this for precise, surgical edits.",
		parameters: getBuiltInTools(process.cwd()).edit.parameters,

		async execute(toolCallId: string, params: any, signal: AbortSignal, onUpdate: any, ctx: any) {
			const tools = getBuiltInTools(ctx.cwd);
			return tools.edit.execute(toolCallId, params, signal, onUpdate);
		},

		renderCall: editCustomRenderCall,
		renderResult: editCustomRenderResult,
	};

	const toggleRenderMode = (ctx: any) => {
		defaultStyleMode = !defaultStyleMode;
		ctx.ui.notify(`pi-mintools: ${defaultStyleMode ? "default-style" : "minimal"} mode`, "info");

		// Force a redraw so existing tool entries re-render with the new mode
		ctx.ui.setToolsExpanded(ctx.ui.getToolsExpanded());
	};

	pi.registerShortcut(TOGGLE_RENDER_MODE_SHORTCUT, {
		description: "Toggle pi-mintools render mode (minimal/default-style)",
		handler: async (ctx) => toggleRenderMode(ctx),
	});

	pi.registerTool(readTool);
	if (bashToolEnabled) {
		pi.registerTool(bashTool);
	}
	pi.registerTool(writeTool);
	pi.registerTool(editTool);
}
