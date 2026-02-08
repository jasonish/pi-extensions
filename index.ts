// SPDX-FileCopyrightText: 2026 Jason Ish
// SPDX-License-Identifier: MIT

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

type Scope = "project" | "global";
type JsonObject = Record<string, unknown>;
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

const GLOBAL_SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
const PROJECT_SETTINGS_RELATIVE_PATH = ".pi/settings.json";
const STATUS_KEY = "startup-model";

interface StartupModelConfig {
	model: string;
	thinkingLevel?: string;
}

interface StartupModelSetting extends StartupModelConfig {
	source: Scope;
}

const tokenize = (rawArgs?: string) => (rawArgs ?? "").trim().split(/\s+/).filter(Boolean);

function getSettingsPath(cwd: string, scope: Scope): string {
	return scope === "global" ? GLOBAL_SETTINGS_PATH : join(cwd, PROJECT_SETTINGS_RELATIVE_PATH);
}

async function readJson(path: string): Promise<JsonObject | undefined> {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonObject) : {};
	} catch {
		return undefined;
	}
}

async function writeJson(path: string, data: JsonObject): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function parseStoredStartupModel(value: unknown): StartupModelConfig | undefined {
	if (typeof value === "string") {
		const model = value.trim();
		return model ? { model } : undefined;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;

	const obj = value as Record<string, unknown>;
	const model = typeof obj.model === "string" ? obj.model.trim() : "";
	if (!model) return undefined;
	const thinkingLevel = typeof obj.thinkingLevel === "string" ? obj.thinkingLevel.trim() : undefined;
	return thinkingLevel ? { model, thinkingLevel } : { model };
}

async function getStartupModelSetting(cwd: string, scope?: Scope): Promise<StartupModelSetting | undefined> {
	const scopes: Scope[] = scope ? [scope] : ["project", "global"];

	for (const currentScope of scopes) {
		const settings = await readJson(getSettingsPath(cwd, currentScope));
		const startup = parseStoredStartupModel(settings?.startupModel);
		if (startup) return { ...startup, source: currentScope };
	}
}

async function setStartupModelSetting(cwd: string, scope: Scope, value?: StartupModelConfig): Promise<string> {
	const path = getSettingsPath(cwd, scope);
	const settings = (await readJson(path)) ?? {};
	if (value) settings.startupModel = value;
	else delete settings.startupModel;
	await writeJson(path, settings);
	return path;
}

function parseModelSpec(spec: string): { provider: string; modelId: string } | undefined {
	const [provider, ...rest] = spec.trim().split("/");
	const modelId = rest.join("/").trim();
	if (!provider?.trim() || !modelId) return undefined;
	return { provider: provider.trim(), modelId };
}

function setStatus(ctx: ExtensionContext, startupModel?: StartupModelConfig): void {
	if (!startupModel?.model) return ctx.ui.setStatus(STATUS_KEY, undefined);
	const detail = startupModel.thinkingLevel ? ` (${startupModel.thinkingLevel})` : "";
	ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", `startup:${startupModel.model}${detail}`));
}

async function applyStartupModel(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const setting = await getStartupModelSetting(ctx.cwd);
	setStatus(ctx, setting);
	if (!setting) return;

	const target = parseModelSpec(setting.model);
	if (!target) {
		ctx.ui.notify(`Invalid startupModel '${setting.model}'. Use provider/model.`, "warning");
		return;
	}

	const model = ctx.modelRegistry.find(target.provider, target.modelId);
	if (!model) {
		ctx.ui.notify(`startupModel not found: ${target.provider}/${target.modelId}`, "warning");
		return;
	}

	if (!ctx.model || ctx.model.provider !== target.provider || ctx.model.id !== target.modelId) {
		const ok = await pi.setModel(model);
		if (!ok) return ctx.ui.notify(`startupModel set, but no API key for ${target.provider}/${target.modelId}`, "warning");
	}

	if (setting.thinkingLevel) pi.setThinkingLevel(setting.thinkingLevel as ThinkingLevel);
}

function parseScope(rawArgs?: string, defaultScope: Scope = "global"): Scope {
	const tokens = tokenize(rawArgs);
	if (tokens.includes("--project") || tokens.includes("-p")) return "project";
	if (tokens.includes("--global") || tokens.includes("-g")) return "global";
	return defaultScope;
}

function wantsHelp(rawArgs?: string): boolean {
	const tokens = tokenize(rawArgs);
	return tokens.some((t) => t === "--help" || t === "-h" || t === "help");
}

function parseShowOrClear(rawArgs?: string): { scope: Scope; action: "show" | "clear" } {
	const tokens = tokenize(rawArgs);
	return {
		scope: parseScope(rawArgs, "global"),
		action: tokens.includes("clear") ? "clear" : "show",
	};
}

export default function startupModelExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		await applyStartupModel(pi, ctx);
	});

	pi.registerCommand("set-default-model", {
		description: "Save current provider/model + thinking level to global startupModel (~/.pi/agent/settings.json)",
		getArgumentCompletions: (prefix) => {
			const opts = ["--help"];
			const filtered = opts.filter((o) => o.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((o) => ({ value: o, label: o })) : null;
		},
		handler: async (args, ctx) => {
			if (wantsHelp(args)) {
				ctx.ui.notify(
					"Usage: /set-default-model (global). For project scope use /set-project-default-model or /set-default-model-project",
					"info",
				);
				return;
			}

			const tokens = tokenize(args);
			if (tokens.includes("--project") || tokens.includes("-p")) {
				ctx.ui.notify("/set-default-model is global-only. Use /set-project-default-model instead.", "warning");
				return;
			}
			if (!ctx.model) return ctx.ui.notify("No active model to save.", "warning");

			const startupModel: StartupModelConfig = {
				model: `${ctx.model.provider}/${ctx.model.id}`,
				thinkingLevel: pi.getThinkingLevel(),
			};
			const path = await setStartupModelSetting(ctx.cwd, "global", startupModel);
			setStatus(ctx, startupModel);
			ctx.ui.notify(
				`Saved startupModel (global) in ${path}: ${startupModel.model} (${startupModel.thinkingLevel ?? "off"})`,
				"info",
			);
		},
	});

	pi.registerCommand("set-project-default-model", {
		description: "Save current provider/model + thinking level to project startupModel (.pi/settings.json)",
		handler: async (_args, ctx) => {
			if (!ctx.model) return ctx.ui.notify("No active model to save.", "warning");

			const startupModel: StartupModelConfig = {
				model: `${ctx.model.provider}/${ctx.model.id}`,
				thinkingLevel: pi.getThinkingLevel(),
			};
			const path = await setStartupModelSetting(ctx.cwd, "project", startupModel);
			setStatus(ctx, startupModel);
			ctx.ui.notify(
				`Saved startupModel (project) in ${path}: ${startupModel.model} (${startupModel.thinkingLevel ?? "off"})`,
				"info",
			);
		},
	});

	pi.registerCommand("set-default-model-project", {
		description: "Alias for /set-project-default-model",
		handler: async (_args, ctx) => {
			if (!ctx.model) return ctx.ui.notify("No active model to save.", "warning");

			const startupModel: StartupModelConfig = {
				model: `${ctx.model.provider}/${ctx.model.id}`,
				thinkingLevel: pi.getThinkingLevel(),
			};
			const path = await setStartupModelSetting(ctx.cwd, "project", startupModel);
			setStatus(ctx, startupModel);
			ctx.ui.notify(
				`Saved startupModel (project) in ${path}: ${startupModel.model} (${startupModel.thinkingLevel ?? "off"})`,
				"info",
			);
		},
	});

	pi.registerCommand("startup-model", {
		description: "Show or clear startupModel (defaults to global). Use --project for local setting.",
		getArgumentCompletions: (prefix) => {
			const opts = ["show", "clear", "--project", "--global", "-p", "-g", "--help"];
			const filtered = opts.filter((o) => o.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((o) => ({ value: o, label: o })) : null;
		},
		handler: async (args, ctx) => {
			if (wantsHelp(args)) {
				ctx.ui.notify("Usage: /startup-model [show|clear] [--global|--project] (default: --global)", "info");
				return;
			}

			const { scope, action } = parseShowOrClear(args);
			if (action === "clear") {
				const path = await setStartupModelSetting(ctx.cwd, scope, undefined);
				setStatus(ctx, undefined);
				return ctx.ui.notify(`Cleared startupModel in ${path}`, "info");
			}

			const setting = await getStartupModelSetting(ctx.cwd, scope);
			if (!setting) return ctx.ui.notify(`startupModel (${scope}): (not set)`, "info");
			const thinking = setting.thinkingLevel ? `, thinking:${setting.thinkingLevel}` : "";
			ctx.ui.notify(`startupModel (${scope}): ${setting.model}${thinking}`, "info");
		},
	});
}
