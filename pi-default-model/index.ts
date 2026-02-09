// SPDX-FileCopyrightText: 2026 Jason Ish
// SPDX-License-Identifier: MIT

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

type Scope = "project" | "global";
type JsonObject = Record<string, unknown>;
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

const GLOBAL_SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
const PROJECT_SETTINGS_RELATIVE_PATH = ".pi/settings.json";

interface StartupModelConfig {
  model: string;
  thinkingLevel?: string;
}

interface StartupModelSetting extends StartupModelConfig {
  source: Scope;
}

const tokenize = (rawArgs?: string) =>
  (rawArgs ?? "").trim().split(/\s+/).filter(Boolean);

function getSettingsPath(cwd: string, scope: Scope): string {
  return scope === "global"
    ? GLOBAL_SETTINGS_PATH
    : join(cwd, PROJECT_SETTINGS_RELATIVE_PATH);
}

async function readJson(path: string): Promise<JsonObject | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : {};
  } catch {
    return undefined;
  }
}

async function writeJson(path: string, data: JsonObject): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function parseStoredStartupModel(
  value: unknown,
): StartupModelConfig | undefined {
  if (typeof value === "string") {
    const model = value.trim();
    return model ? { model } : undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;

  const obj = value as Record<string, unknown>;
  const model = typeof obj.model === "string" ? obj.model.trim() : "";
  if (!model) return undefined;
  const thinkingLevel =
    typeof obj.thinkingLevel === "string"
      ? obj.thinkingLevel.trim()
      : undefined;
  return thinkingLevel ? { model, thinkingLevel } : { model };
}

async function getStartupModelSetting(
  cwd: string,
  scope?: Scope,
): Promise<StartupModelSetting | undefined> {
  const scopes: Scope[] = scope ? [scope] : ["project", "global"];

  for (const currentScope of scopes) {
    const settings = await readJson(getSettingsPath(cwd, currentScope));
    const startup = parseStoredStartupModel(settings?.startupModel);
    if (startup) return { ...startup, source: currentScope };
  }
}

async function setStartupModelSetting(
  cwd: string,
  scope: Scope,
  value?: StartupModelConfig,
): Promise<string> {
  const path = getSettingsPath(cwd, scope);
  const settings = (await readJson(path)) ?? {};
  if (value) settings.startupModel = value;
  else delete settings.startupModel;
  await writeJson(path, settings);
  return path;
}

function parseModelSpec(
  spec: string,
): { provider: string; modelId: string } | undefined {
  const [provider, ...rest] = spec.trim().split("/");
  const modelId = rest.join("/").trim();
  if (!provider?.trim() || !modelId) return undefined;
  return { provider: provider.trim(), modelId };
}

async function applyStartupModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  const setting = await getStartupModelSetting(ctx.cwd);
  if (!setting) return;

  const target = parseModelSpec(setting.model);
  if (!target) {
    ctx.ui.notify(
      `Invalid startupModel '${setting.model}'. Use provider/model.`,
      "warning",
    );
    return;
  }

  const model = ctx.modelRegistry.find(target.provider, target.modelId);
  if (!model) {
    ctx.ui.notify(
      `startupModel not found: ${target.provider}/${target.modelId}`,
      "warning",
    );
    return;
  }

  if (
    !ctx.model ||
    ctx.model.provider !== target.provider ||
    ctx.model.id !== target.modelId
  ) {
    const ok = await pi.setModel(model);
    if (!ok)
      return ctx.ui.notify(
        `startupModel set, but no API key for ${target.provider}/${target.modelId}`,
        "warning",
      );
  }

  if (setting.thinkingLevel)
    pi.setThinkingLevel(setting.thinkingLevel as ThinkingLevel);
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

function wantsClear(rawArgs?: string): boolean {
  const tokens = tokenize(rawArgs);
  return tokens.includes("--clear") || tokens.includes("-c");
}

export default function startupModelExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    await applyStartupModel(pi, ctx);
  });

  pi.registerCommand("set-default-model", {
    description:
      "Set or clear startupModel (global by default, use --project for local)",
    getArgumentCompletions: (prefix) => {
      const opts = ["--project", "--global", "--clear", "--help"];
      const filtered = opts.filter((o) => o.startsWith(prefix));
      return filtered.length > 0
        ? filtered.map((o) => ({ value: o, label: o }))
        : null;
    },
    handler: async (args, ctx) => {
      if (wantsHelp(args)) {
        ctx.ui.notify(
          [
            "Usage:",
            "  /set-default-model",
            "  /set-default-model --project",
            "  /set-default-model --clear [--project]",
            "  /set-default-model --help",
          ].join("\n"),
          "info",
        );
        return;
      }

      const scope = parseScope(args, "global");
      if (wantsClear(args)) {
        const path = await setStartupModelSetting(ctx.cwd, scope, undefined);
        ctx.ui.notify(`Cleared startupModel (${scope}) in ${path}`, "info");
        return;
      }

      if (!ctx.model) {
        ctx.ui.notify("No active model to save.", "warning");
        return;
      }

      const startupModel: StartupModelConfig = {
        model: `${ctx.model.provider}/${ctx.model.id}`,
        thinkingLevel: pi.getThinkingLevel(),
      };
      const path = await setStartupModelSetting(ctx.cwd, scope, startupModel);
      ctx.ui.notify(
        `Saved startupModel (${scope}) in ${path}: ${startupModel.model} (${startupModel.thinkingLevel ?? "off"})`,
        "info",
      );
    },
  });
}
