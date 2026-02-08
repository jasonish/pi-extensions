import os from "node:os";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

const ANSI = {
  reset: "\u001b[0m",
  magenta: "\u001b[35m",
  darkGrey: "\u001b[90m",
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  blue: "\u001b[34m",
  brightYellow: "\u001b[93m",
  brightGreen: "\u001b[92m",
  brightRed: "\u001b[91m",
} as const;

const FOOTER_TICK_KEY = "myway-footer-tick";
const TOKEN_WIDGET_KEY = "myway-token-widget";

type TokenTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

function color(code: string, text: string): string {
  return `${code}${text}${ANSI.reset}`;
}

function withTildeHome(path: string): string {
  const home = os.homedir();
  if (path === home) return "~";
  if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  return path;
}

function compactPathForFooter(path: string, keepTail = 2): string {
  if (path === "~") return path;

  const parts = path.split("/").filter(Boolean);
  if (parts.length <= keepTail + 1) return path;

  const tail = parts.slice(-keepTail).join("/");

  if (parts[0] === "~") return `~/…/${tail}`;
  if (path.startsWith("/")) return `/…/${tail}`;
  return `${parts[0]}/…/${tail}`;
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function computeTokenTotals(
  ctx: Pick<ExtensionContext, "sessionManager">,
): TokenTotals {
  const totals: TokenTotals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };

  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "message" || entry.message.role !== "assistant")
      continue;

    totals.input += entry.message.usage.input;
    totals.output += entry.message.usage.output;
    totals.cacheRead += entry.message.usage.cacheRead;
    totals.cacheWrite += entry.message.usage.cacheWrite;
  }

  return totals;
}

function buildTokenInfo(
  ctx: Pick<ExtensionContext, "getContextUsage">,
  totals: TokenTotals,
  elapsedTenths?: number,
): string {
  const parts: string[] = [
    `↑${formatTokens(totals.input)}`,
    `↓${formatTokens(totals.output)}`,
  ];

  if (totals.cacheRead) parts.push(`R${formatTokens(totals.cacheRead)}`);
  if (totals.cacheWrite) parts.push(`W${formatTokens(totals.cacheWrite)}`);

  const context = ctx.getContextUsage();
  if (context) {
    parts.push(
      `${Math.round(context.percent)}%/${formatTokens(context.contextWindow)}`,
    );
  }

  if (typeof elapsedTenths === "number") {
    parts.push(`[${(elapsedTenths / 10).toFixed(1)}s]`);
  }

  return parts.join(" ");
}

function sandboxStatusShort(
  statusText: string | undefined,
): "RO" | "RW" | "YOLO" | undefined {
  if (!statusText) return undefined;

  const s = statusText.toLowerCase();
  if (s.includes("read-only")) return "RO";
  if (s.includes("read-write")) return "RW";
  if (s.includes("yolo") || s.includes("no restrictions")) return "YOLO";
  return undefined;
}

/**
 * Pi extension skeleton.
 */
export default function (pi: ExtensionAPI) {
  let activeModel = "no-model";
  let tokenTotals: TokenTotals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  let interactionStartedAtMs: number | undefined;
  let lastElapsedTenths: number | undefined;
  let interactionTimer: ReturnType<typeof setInterval> | undefined;
  let tokenWidgetText = "";
  let tokenWidgetVisible = false;

  const updateModelLabel = (ctx: Pick<ExtensionContext, "model">) => {
    activeModel = ctx.model
      ? `${ctx.model.provider}/${ctx.model.id}`
      : "no-model";
  };

  const refreshTokenTotals = (
    ctx: Pick<ExtensionContext, "sessionManager">,
  ) => {
    tokenTotals = computeTokenTotals(ctx);
  };

  const clearFooterTick = (ctx: Pick<ExtensionContext, "hasUI" | "ui">) => {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(FOOTER_TICK_KEY, undefined);
  };

  const forceFooterRerender = (ctx: Pick<ExtensionContext, "hasUI" | "ui">) => {
    if (!ctx.hasUI) return;
    // Status text is not rendered by this custom footer; used only to trigger repaint.
    ctx.ui.setStatus(FOOTER_TICK_KEY, `${Date.now()}`);
  };

  const hideTokenWidget = (ctx: Pick<ExtensionContext, "hasUI" | "ui">) => {
    if (!ctx.hasUI || !tokenWidgetVisible) return;
    ctx.ui.setWidget(TOKEN_WIDGET_KEY, undefined);
    tokenWidgetVisible = false;
    tokenWidgetText = "";
  };

  const showTokenWidget = (ctx: Pick<ExtensionContext, "hasUI" | "ui">) => {
    if (!ctx.hasUI || tokenWidgetVisible) return;

    ctx.ui.setWidget(
      TOKEN_WIDGET_KEY,
      () => ({
        invalidate() {},
        render(width: number): string[] {
          if (!tokenWidgetText) return [];

          const textWidth = visibleWidth(tokenWidgetText);
          if (textWidth <= width) {
            const pad = " ".repeat(Math.max(0, width - textWidth));
            return [pad + tokenWidgetText];
          }

          return [truncateToWidth(tokenWidgetText, width)];
        },
      }),
      { placement: "aboveEditor" },
    );

    tokenWidgetVisible = true;
  };

  const installFooter = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;

    ctx.ui.setFooter((_tui, _theme, footerData) => ({
      invalidate() {},
      render(width: number): string[] {
        const level = pi.getThinkingLevel();
        const slash = activeModel.indexOf("/");
        const provider = slash >= 0 ? activeModel.slice(0, slash) : activeModel;
        const modelId = slash >= 0 ? activeModel.slice(slash + 1) : "";

        const thinkingColor = level === "off" ? ANSI.yellow : ANSI.green;

        const modelText = modelId
          ? color(ANSI.magenta, provider) +
            color(ANSI.darkGrey, "/") +
            color(ANSI.cyan, modelId) +
            color(ANSI.darkGrey, "#") +
            color(thinkingColor, level)
          : color(ANSI.magenta, provider) +
            color(ANSI.darkGrey, "#") +
            color(thinkingColor, level);

        const sandboxRaw = footerData.getExtensionStatuses().get("pi-sandbox");
        const sandbox = sandboxStatusShort(sandboxRaw);

        let sandboxBadge = "";
        if (sandbox === "RO") sandboxBadge = color(ANSI.brightYellow, "[RO]");
        else if (sandbox === "RW")
          sandboxBadge = color(ANSI.brightGreen, "[RW]");
        else if (sandbox === "YOLO")
          sandboxBadge = color(ANSI.brightRed, "[YOLO]");

        const cwd = compactPathForFooter(withTildeHome(process.cwd()));
        const left = `${sandboxBadge ? `${sandboxBadge} ` : ""}${modelText} ${color(ANSI.blue, cwd)}`;
        const elapsedTenths =
          interactionStartedAtMs == null
            ? lastElapsedTenths
            : Math.floor((Date.now() - interactionStartedAtMs) / 100);
        const right = buildTokenInfo(ctx, tokenTotals, elapsedTenths);

        const leftWidth = visibleWidth(left);
        const rightWidth = visibleWidth(right);

        if (leftWidth + 1 + rightWidth <= width) {
          hideTokenWidget(ctx);
          const pad = " ".repeat(Math.max(1, width - leftWidth - rightWidth));
          return [left + pad + right];
        }

        // Fallback: keep footer single-line and show token stats in a widget above the editor.
        tokenWidgetText = right;
        showTokenWidget(ctx);

        const line1 = truncateToWidth(left, width);
        return [line1];
      },
    }));
  };

  pi.on("session_start", async (_event, ctx) => {
    updateModelLabel(ctx);
    refreshTokenTotals(ctx);
    installFooter(ctx);
    forceFooterRerender(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    if (interactionTimer) {
      clearInterval(interactionTimer);
      interactionTimer = undefined;
    }
    interactionStartedAtMs = undefined;
    lastElapsedTenths = undefined;
    hideTokenWidget(ctx);
    updateModelLabel(ctx);
    refreshTokenTotals(ctx);
    forceFooterRerender(ctx);
  });

  pi.on("model_select", async (event, ctx) => {
    activeModel = `${event.model.provider}/${event.model.id}`;
    forceFooterRerender(ctx);
  });

  // Start a 0.1s timer for the full agent interaction (all turns/tool calls).
  pi.on("agent_start", async (_event, ctx) => {
    if (interactionTimer) {
      clearInterval(interactionTimer);
      interactionTimer = undefined;
    }

    interactionStartedAtMs = Date.now();
    lastElapsedTenths = 0;
    forceFooterRerender(ctx);

    interactionTimer = setInterval(() => {
      if (interactionStartedAtMs == null) return;
      forceFooterRerender(ctx);
    }, 100);
  });

  // Keep token totals fresh as each turn completes inside one interaction.
  pi.on("turn_end", async (_event, ctx) => {
    refreshTokenTotals(ctx);
    forceFooterRerender(ctx);
  });

  // Stop timer and keep final elapsed time once the full interaction completes.
  pi.on("agent_end", async (_event, ctx) => {
    if (interactionTimer) {
      clearInterval(interactionTimer);
      interactionTimer = undefined;
    }

    if (interactionStartedAtMs != null) {
      lastElapsedTenths = Math.floor(
        (Date.now() - interactionStartedAtMs) / 100,
      );
    }
    interactionStartedAtMs = undefined;

    refreshTokenTotals(ctx);
    forceFooterRerender(ctx);
    clearFooterTick(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (interactionTimer) {
      clearInterval(interactionTimer);
      interactionTimer = undefined;
    }
    hideTokenWidget(ctx);
    clearFooterTick(ctx);
  });

  pi.registerCommand("myway", {
    description: "Skeleton command. Replace with your own behavior.",
    handler: async (args, ctx) => {
      const text = args?.trim() || "Hello from pi-myway";
      if (ctx.hasUI) ctx.ui.notify(text, "info");
    },
  });

  pi.registerTool({
    name: "myway_echo",
    label: "MyWay Echo",
    description: "Echo text back to the model (skeleton tool).",
    parameters: Type.Object({
      text: Type.String({ description: "Text to echo" }),
    }),
    async execute(_toolCallId, params) {
      const text = (params as { text: string }).text;
      return {
        content: [{ type: "text", text: `Echo: ${text}` }],
        details: { echoed: text },
      };
    },
  });
}
