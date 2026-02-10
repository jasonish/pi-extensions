// SPDX-FileCopyrightText: 2026 Jason Ish
// SPDX-License-Identifier: MIT

import { basename } from "node:path";
import {
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import {
  Container,
  fuzzyMatch,
  type Focusable,
  getEditorKeybindings,
  Input,
  Loader,
  Spacer,
  Text,
  type TUI,
} from "@mariozechner/pi-tui";

const SHORTCUT = "ctrl+alt+r";
const CACHE_TTL_MS = 30_000;
const MAX_RESULTS = 120;
const MAX_VISIBLE = 10;

interface PromptRecord {
  text: string;
  timestamp: number;
  sessionPath: string;
  sessionName?: string;
  cwd: string;
  searchText: string;
}

interface IndexBuildProgress {
  phase: "sessions" | "prompts";
  loaded: number;
  total: number;
}

type IndexBuildProgressCallback = (progress: IndexBuildProgress) => void;

let promptCache: PromptRecord[] = [];
let cacheUpdatedAt = 0;

function extractText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  return content
    .filter((block): block is { type: string; text?: string } => !!block && typeof block === "object")
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function preview(text: string, max = 80): string {
  const cleaned = compactWhitespace(text);
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 1)}…`;
}

function getTimestamp(messageTimestamp: unknown, entryTimestamp: unknown, fallback: number): number {
  if (typeof messageTimestamp === "number" && Number.isFinite(messageTimestamp)) return messageTimestamp;
  if (typeof entryTimestamp === "string") {
    const parsed = new Date(entryTimestamp).getTime();
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function buildSearchText(text: string, sessionName: string | undefined, cwd: string): string {
  return `${text}\n${sessionName ?? ""}\n${cwd}`.toLowerCase();
}

function getCurrentSessionIdentity(ctx: ExtensionContext): {
  sessionPath: string;
  sessionName?: string;
  cwd: string;
} {
  const sessionPath = ctx.sessionManager.getSessionFile() ?? "(ephemeral-session)";
  const sessionName = ctx.sessionManager.getSessionName();
  return { sessionPath, sessionName, cwd: ctx.cwd };
}

function collectCurrentSessionPrompts(ctx: ExtensionContext): PromptRecord[] {
  const { sessionPath, sessionName, cwd } = getCurrentSessionIdentity(ctx);
  const records: PromptRecord[] = [];

  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "message") continue;

    const msg = entry.message as {
      role?: string;
      content?: unknown;
      timestamp?: unknown;
    };
    if (msg.role !== "user") continue;

    const text = extractText(msg.content);
    if (!text) continue;

    const timestamp = getTimestamp(msg.timestamp, entry.timestamp, Date.now());
    records.push({
      text,
      timestamp,
      sessionPath,
      sessionName,
      cwd,
      searchText: buildSearchText(text, sessionName, cwd),
    });
  }

  return records;
}

function mergePromptRecords(base: PromptRecord[], extra: PromptRecord[]): PromptRecord[] {
  const merged = [...base, ...extra];
  const unique = new Map<string, PromptRecord>();

  for (const record of merged) {
    const key = `${record.sessionPath}|${record.timestamp}|${record.text}`;
    if (!unique.has(key)) unique.set(key, record);
  }

  return [...unique.values()].sort((a, b) => b.timestamp - a.timestamp);
}

function formatIndexBuildProgress(progress: IndexBuildProgress): string {
  const label = progress.phase === "sessions" ? "Scanning sessions" : "Indexing prompts";
  if (progress.total <= 0) return `${label}...`;

  const percent = Math.min(100, Math.round((progress.loaded / progress.total) * 100));
  return `${label}: ${progress.loaded}/${progress.total} (${percent}%)`;
}

async function buildPromptIndex(onProgress?: IndexBuildProgressCallback): Promise<PromptRecord[]> {
  const sessions = await SessionManager.listAll((loaded, total) => {
    onProgress?.({ phase: "sessions", loaded, total });
  });
  const prompts: PromptRecord[] = [];
  let processedSessions = 0;
  const totalSessions = sessions.length;

  if (totalSessions === 0) {
    onProgress?.({ phase: "prompts", loaded: 0, total: 0 });
  }

  for (const session of sessions) {
    try {
      const manager = SessionManager.open(session.path);

      for (const entry of manager.getEntries()) {
        if (entry.type !== "message") continue;

        const msg = entry.message as {
          role?: string;
          content?: unknown;
          timestamp?: unknown;
        };
        if (msg.role !== "user") continue;

        const text = extractText(msg.content);
        if (!text) continue;

        const timestamp = getTimestamp(msg.timestamp, entry.timestamp, session.modified.getTime());

        prompts.push({
          text,
          timestamp,
          sessionPath: session.path,
          sessionName: session.name,
          cwd: session.cwd,
          searchText: buildSearchText(text, session.name, session.cwd),
        });
      }
    } catch {
      // Ignore unreadable/malformed sessions.
    }

    processedSessions++;
    onProgress?.({ phase: "prompts", loaded: processedSessions, total: totalSessions });
  }

  prompts.sort((a, b) => b.timestamp - a.timestamp);
  return prompts;
}

async function getPromptIndex(force = false, onProgress?: IndexBuildProgressCallback): Promise<PromptRecord[]> {
  const stale = Date.now() - cacheUpdatedAt > CACHE_TTL_MS;
  if (force || stale || promptCache.length === 0) {
    promptCache = await buildPromptIndex(onProgress);
    cacheUpdatedAt = Date.now();
  }
  return promptCache;
}

function filterPrompts(records: PromptRecord[], query: string): PromptRecord[] {
  const trimmed = query.trim();
  if (!trimmed) return records.slice(0, MAX_RESULTS);

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const filtered = records.filter((record) => {
    return tokens.every((token) => fuzzyMatch(token, record.searchText).matches);
  });

  // Preserve original record order (already sorted by recency).
  return filtered.slice(0, MAX_RESULTS);
}

function formatRecordLine(record: PromptRecord, theme: Theme, selected: boolean): string {
  const promptText = selected
    ? theme.fg("accent", preview(record.text))
    : theme.fg("text", preview(record.text));

  return `${selected ? "→ " : "  "}${promptText}`;
}

class PromptHistorySelector extends Container implements Focusable {
  private readonly searchInput: Input;
  private readonly listContainer: Container;
  private readonly records: PromptRecord[];
  private readonly theme: Theme;
  private readonly tui: TUI;
  private readonly onSelect: (record: PromptRecord) => void;
  private readonly onCancel: () => void;

  private filteredRecords: PromptRecord[] = [];
  private selectedIndex = 0;

  // Focusable implementation - propagate to child input for IME cursor positioning
  private _focused = false;
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  constructor(
    tui: TUI,
    theme: Theme,
    records: PromptRecord[],
    onSelect: (record: PromptRecord) => void,
    onCancel: () => void,
  ) {
    super();

    this.tui = tui;
    this.theme = theme;
    this.records = records;
    this.onSelect = onSelect;
    this.onCancel = onCancel;

    this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    this.addChild(new Text(theme.fg("accent", theme.bold(" Prompt History Search ")), 0, 0));
    this.addChild(new Text(theme.fg("dim", "Type to filter (fzf-style fuzzy match)"), 0, 0));
    this.addChild(new Spacer(1));

    this.searchInput = new Input();
    this.searchInput.onSubmit = () => this.selectCurrent();
    this.searchInput.onEscape = () => this.onCancel();
    this.addChild(this.searchInput);

    this.addChild(new Spacer(1));

    this.listContainer = new Container();
    this.addChild(this.listContainer);

    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg("dim", "↑↓ move • enter select • esc cancel"), 0, 0));
    this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    this.applyFilter("");
  }

  private applyFilter(query: string): void {
    this.filteredRecords = filterPrompts(this.records, query);
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredRecords.length - 1));
    this.rebuildList();
  }

  private rebuildList(): void {
    this.listContainer.clear();

    if (this.filteredRecords.length === 0) {
      this.listContainer.addChild(new Text(this.theme.fg("warning", "No matching prompts"), 0, 0));
      return;
    }

    const startIndex = Math.max(
      0,
      Math.min(this.selectedIndex - Math.floor(MAX_VISIBLE / 2), this.filteredRecords.length - MAX_VISIBLE),
    );
    const endIndex = Math.min(startIndex + MAX_VISIBLE, this.filteredRecords.length);

    for (let i = startIndex; i < endIndex; i++) {
      const record = this.filteredRecords[i]!;
      const isSelected = i === this.selectedIndex;
      this.listContainer.addChild(new Text(formatRecordLine(record, this.theme, isSelected), 0, 0));
    }

    if (startIndex > 0 || endIndex < this.filteredRecords.length) {
      this.listContainer.addChild(
        new Text(this.theme.fg("muted", `(${this.selectedIndex + 1}/${this.filteredRecords.length})`), 0, 0),
      );
    }
  }

  private selectCurrent(): void {
    const selected = this.filteredRecords[this.selectedIndex];
    if (selected) this.onSelect(selected);
  }

  handleInput(data: string): void {
    const kb = getEditorKeybindings();

    if (kb.matches(data, "selectUp")) {
      if (this.filteredRecords.length > 0) {
        this.selectedIndex = this.selectedIndex === 0 ? this.filteredRecords.length - 1 : this.selectedIndex - 1;
        this.rebuildList();
      }
    } else if (kb.matches(data, "selectDown")) {
      if (this.filteredRecords.length > 0) {
        this.selectedIndex = this.selectedIndex === this.filteredRecords.length - 1 ? 0 : this.selectedIndex + 1;
        this.rebuildList();
      }
    } else if (kb.matches(data, "selectPageUp")) {
      if (this.filteredRecords.length > 0) {
        this.selectedIndex = Math.max(0, this.selectedIndex - MAX_VISIBLE);
        this.rebuildList();
      }
    } else if (kb.matches(data, "selectPageDown")) {
      if (this.filteredRecords.length > 0) {
        this.selectedIndex = Math.min(this.filteredRecords.length - 1, this.selectedIndex + MAX_VISIBLE);
        this.rebuildList();
      }
    } else if (kb.matches(data, "selectConfirm")) {
      this.selectCurrent();
    } else if (kb.matches(data, "selectCancel")) {
      this.onCancel();
    } else {
      this.searchInput.handleInput(data);
      this.selectedIndex = 0;
      this.applyFilter(this.searchInput.getValue());
    }

    this.tui.requestRender();
  }
}

export default function promptHistoryExtension(pi: ExtensionAPI) {
  pi.registerShortcut(SHORTCUT, {
    description: "Search prompt history across all sessions",
    handler: async (ctx) => {
      let loadError: unknown;

      const indexedRecords = await ctx.ui.custom<PromptRecord[] | null>((tui, theme, _keybindings, done) => {
        const container = new Container();
        const borderColor = (s: string) => theme.fg("accent", s);

        container.addChild(new DynamicBorder(borderColor));
        container.addChild(new Text(theme.fg("accent", theme.bold(" Loading prompt history ")), 0, 0));

        const loader = new Loader(
          tui,
          (s: string) => theme.fg("accent", s),
          (s: string) => theme.fg("muted", s),
          "Starting...",
        );
        container.addChild(loader);
        container.addChild(new Spacer(1));
        container.addChild(new DynamicBorder(borderColor));

        getPromptIndex(false, (progress) => {
          loader.setMessage(formatIndexBuildProgress(progress));
        })
          .then((result) => done(result))
          .catch((error) => {
            loadError = error;
            done(null);
          });

        return {
          render: (width: number) => container.render(width),
          invalidate: () => container.invalidate(),
          dispose: () => loader.stop(),
        };
      });

      if (indexedRecords === null) {
        const message = loadError instanceof Error ? loadError.message : loadError ? String(loadError) : "Unknown error";
        ctx.ui.notify(`History index failed: ${message}`, "error");
        return;
      }

      const records = mergePromptRecords(indexedRecords, collectCurrentSessionPrompts(ctx));

      if (records.length === 0) {
        ctx.ui.notify("No user prompts found in session history.", "warning");
        return;
      }

      const selected = await ctx.ui.custom<PromptRecord | null>((tui, theme, _keybindings, done) => {
        return new PromptHistorySelector(
          tui,
          theme,
          records,
          (record) => done(record),
          () => done(null),
        );
      });

      if (!selected) return;

      ctx.ui.setEditorText(selected.text);
      const source = selected.sessionName?.trim() || basename(selected.sessionPath);
      ctx.ui.notify(`Loaded prompt from ${source}`, "info");
    },
  });
}
