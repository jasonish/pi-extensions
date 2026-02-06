// SPDX-FileCopyrightText: 2026 Jason Ish
// SPDX-License-Identifier: MIT

import { spawnSync } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import {
  dirname,
  isAbsolute,
  join as joinPath,
  relative,
  resolve,
  sep,
} from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
  createBashTool,
  isToolCallEventType,
} from "@mariozechner/pi-coding-agent";

/**
 * pi-sandbox
 *
 * Exposes 3 user-facing modes:
 * - read-only   : block edit/write tool calls and sandbox bash with a read-only filesystem view
 * - read-write  : allow edit/write only under the directory pi was started in (recursively);
 *                bash is sandboxed via bwrap so it can only write under that same root (and host /tmp)
 * - yolo        : allow everything (no restrictions; no sandboxing)
 */

type SandboxMode = "read-only" | "read-write" | "yolo";

function normalizeMode(
  input: string | undefined | null,
): SandboxMode | undefined {
  if (!input) return undefined;
  const s = input.trim().toLowerCase();
  if (s === "read-only" || s === "readonly" || s === "ro") return "read-only";
  if (s === "read-write" || s === "readwrite" || s === "rw")
    return "read-write";
  if (s === "yolo") return "yolo";
  return undefined;
}

function expandUserPath(p: string): string {
  // Keep in sync with common pi path conventions:
  // - Some models include a leading '@' in paths.
  // - Expand ~ and ~/.
  const noAt = p.startsWith("@") ? p.slice(1) : p;
  if (noAt === "~") return homedir();
  if (noAt.startsWith("~/")) return joinPath(homedir(), noAt.slice(2));
  return noAt;
}

async function canonicalizePossiblyMissingPath(
  absPath: string,
): Promise<string> {
  // realpath() fails for non-existent files. For writes/edits, walk up to the nearest
  // existing parent, realpath that, then re-append the remainder.
  let cur = absPath;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await stat(cur);
      const realCur = await realpath(cur);
      const remainder = relative(cur, absPath);
      return remainder ? resolve(realCur, remainder) : realCur;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return absPath;
      cur = parent;
    }
  }
}

function isPathInsideRoot(rootAbs: string, targetAbs: string): boolean {
  const rel = relative(rootAbs, targetAbs);
  if (rel === "") return true;
  if (rel === "..") return false;
  if (rel.startsWith(`..${sep}`)) return false;
  if (isAbsolute(rel)) return false;
  return true;
}

function shellEscapeSingle(s: string): string {
  // Safe for /bin/sh -c strings; used to construct the bwrap invocation passed to the host shell.
  // Wrap in single quotes and escape embedded single quotes.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function findBwrapStrict(): Promise<string | null> {
  // Only trust bwrap at a known path. This avoids accidentally picking up an
  // unexpected binary earlier in PATH.
  const candidates = ["/usr/bin/bwrap", "/bin/bwrap"];
  for (const p of candidates) {
    try {
      const st = await stat(p);
      if (st.isFile() && (st.mode & 0o111) !== 0) return p;
    } catch {
      // ignore
    }
  }
  return null;
}

export default function (pi: ExtensionAPI) {
  let rootDir = process.cwd();
  let rootDirReal = rootDir;
  let rootInit: Promise<void> | undefined;
  let bwrapPath: string | null = null;

  // Git metadata directories (important for git worktrees, where .git is a gitfile
  // pointing at a real repository directory elsewhere).
  let gitDirReal: string | null = null;
  let gitCommonDirReal: string | null = null;

  // Extra writable directories required for git to function (e.g. the real .git
  // directory when we're in a worktree or started pi in a subdirectory).
  let extraWritableDirs: string[] = [];

  let mode: SandboxMode = "read-write";

  pi.registerFlag("sandbox-mode", {
    description: "pi-sandbox mode: read-only | read-write | yolo",
    type: "string",
    default: "read-write",
  });

  // Pick up initial mode from CLI flag.
  const initialFlag = pi.getFlag("--sandbox-mode");
  const initialMode =
    typeof initialFlag === "string" ? normalizeMode(initialFlag) : undefined;
  if (initialMode) mode = initialMode;

  async function ensureRoot(ctx: { cwd: string }) {
    if (!rootInit) {
      rootDir = ctx.cwd;
      rootInit = (async () => {
        try {
          rootDirReal = await realpath(rootDir);
        } catch {
          rootDirReal = rootDir;
        }

        // bwrap is required to safely sandbox bash.
        // Only accept it from a known location.
        bwrapPath = await findBwrapStrict();

        // Detect git metadata directories so git works in read-write mode when
        // pi is started at the *root of a worktree* (i.e. rootDirReal contains a
        // .git entry).
        //
        // Security/expectation: if pi is started in a subdirectory of a larger
        // repo (e.g. repo/src), we intentionally do NOT grant write access to the
        // repository's .git directory outside the sandbox root, even though `git`
        // would work there on the host.
        gitDirReal = null;
        gitCommonDirReal = null;
        extraWritableDirs = [];
        try {
          let dotGitExists = false;
          try {
            await stat(joinPath(rootDirReal, ".git"));
            dotGitExists = true;
          } catch {
            dotGitExists = false;
          }

          if (dotGitExists) {
            const inside = spawnSync(
              "git",
              ["rev-parse", "--is-inside-work-tree"],
              {
                cwd: rootDirReal,
                encoding: "utf-8",
                timeout: 2000,
              },
            );
            if (
              inside.status === 0 &&
              (inside.stdout ?? "").trim() === "true"
            ) {
              const gitDir = spawnSync(
                "git",
                ["rev-parse", "--absolute-git-dir"],
                {
                  cwd: rootDirReal,
                  encoding: "utf-8",
                  timeout: 2000,
                },
              );
              const gitCommonDir = spawnSync(
                "git",
                ["rev-parse", "--path-format=absolute", "--git-common-dir"],
                {
                  cwd: rootDirReal,
                  encoding: "utf-8",
                  timeout: 2000,
                },
              );

              const gitDirOut = (gitDir.stdout ?? "").trim().split(/\r?\n/)[0];
              const gitCommonOut = (gitCommonDir.stdout ?? "")
                .trim()
                .split(/\r?\n/)[0];

              if (gitDir.status === 0 && gitDirOut) {
                try {
                  gitDirReal = await realpath(gitDirOut);
                } catch {
                  gitDirReal = gitDirOut;
                }
              }

              if (gitCommonDir.status === 0 && gitCommonOut) {
                try {
                  gitCommonDirReal = await realpath(gitCommonOut);
                } catch {
                  gitCommonDirReal = gitCommonOut;
                }
              }

              // Only add git metadata directories that live *outside* the sandbox root.
              // Also de-duplicate nested paths: if we bind the common dir (e.g. .../.git),
              // there's no need to also bind a child directory (e.g. .../.git/worktrees/<name>).
              const extras = new Set<string>();
              const candidates = [gitDirReal, gitCommonDirReal].filter(
                (p): p is string => !!p && !isPathInsideRoot(rootDirReal, p),
              );

              if (
                gitCommonDirReal &&
                gitDirReal &&
                gitCommonDirReal !== gitDirReal &&
                isPathInsideRoot(gitCommonDirReal, gitDirReal)
              ) {
                // Common dir contains the worktree dir.
                const idx = candidates.indexOf(gitDirReal);
                if (idx !== -1) candidates.splice(idx, 1);
              } else if (
                gitCommonDirReal &&
                gitDirReal &&
                gitCommonDirReal !== gitDirReal &&
                isPathInsideRoot(gitDirReal, gitCommonDirReal)
              ) {
                // Worktree dir contains the common dir (unusual, but handle it).
                const idx = candidates.indexOf(gitCommonDirReal);
                if (idx !== -1) candidates.splice(idx, 1);
              }

              for (const p of candidates) extras.add(p);
              extraWritableDirs = [...extras];
            }
          }
        } catch {
          // ignore git detection failures
        }
      })();
    }
    await rootInit;
  }

  function updateUI(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    const suffix = mode === "yolo" ? "(no restrictions)" : mode;
    ctx.ui.setStatus("pi-sandbox", `sandbox: ${suffix}`);
  }

  function updateActiveToolsForMode() {
    // Convenience only: prevents the model from *seeing* edit/write tools in read-only mode.
    // Enforcement still happens in tool_call interception.
    const current = pi.getActiveTools();
    const all = new Set(pi.getAllTools().map((t) => t.name));
    const withoutEditWrite = current.filter(
      (t) => t !== "edit" && t !== "write",
    );

    if (mode === "read-only") {
      pi.setActiveTools(withoutEditWrite);
      return;
    }

    // read-write / yolo: ensure edit+write are present if available.
    const next = [...withoutEditWrite];
    if (all.has("edit") && !next.includes("edit")) next.push("edit");
    if (all.has("write") && !next.includes("write")) next.push("write");
    pi.setActiveTools(next);
  }

  function setMode(next: SandboxMode, ctx?: ExtensionContext) {
    mode = next;
    updateActiveToolsForMode();
    if (ctx) updateUI(ctx);
  }

  function buildWriteAccessLines(): string[] {
    // What the *agent tools* are allowed to write.
    switch (mode) {
      case "read-only":
        return ["- none (read-only mode)"];
      case "read-write": {
        // Keep this simple: show the actual directories that may be written to.
        // (We intentionally don't distinguish between tools here.)
        const lines: string[] = [];
        lines.push(`- ${rootDirReal}${sep}**`);
        if (bwrapPath) lines.push("- /tmp");
        for (const dir of extraWritableDirs) {
          lines.push(`- ${dir}${sep}** (git metadata)`);
        }
        return lines;
      }
      case "yolo":
        return ["- unrestricted (full host write access)"];
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    await ensureRoot(ctx);
    setMode(mode, ctx);

    if (ctx.hasUI) {
      const lines = [
        "[Sandbox]",
        `mode: ${mode}`,
        "write access:",
        ...buildWriteAccessLines(),
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    }
  });

  pi.registerCommand("sandbox-mode", {
    description: "Set pi-sandbox mode (read-only | read-write | yolo)",
    getArgumentCompletions: (prefix) => {
      const modes: SandboxMode[] = ["read-only", "read-write", "yolo"];
      return modes
        .filter((m) => m.startsWith(prefix))
        .map((m) => ({ value: m, label: m }));
    },
    handler: async (args, ctx) => {
      await ensureRoot(ctx);
      let requested = args?.trim();
      if (!requested) {
        if (!ctx.hasUI) {
          ctx.ui.notify(`Current mode: ${mode}`, "info");
          return;
        }
        const choice = await ctx.ui.select("Sandbox mode:", [
          "read-only",
          "read-write",
          "yolo",
        ]);
        if (!choice) return;
        requested = choice;
      }

      const next = normalizeMode(requested);
      if (!next) {
        ctx.ui.notify(
          `Unknown mode: ${requested}. Use: read-only | read-write | yolo`,
          "error",
        );
        return;
      }

      setMode(next, ctx);
      ctx.ui.notify(`pi-sandbox mode: ${mode}`, "info");
    },
  });

  pi.registerShortcut("ctrl+x", {
    description: "Cycle pi-sandbox mode (read-only → read-write → yolo)",
    handler: async (ctx) => {
      await ensureRoot(ctx);
      const next: SandboxMode =
        mode === "read-only"
          ? "read-write"
          : mode === "read-write"
            ? "yolo"
            : "read-only";
      setMode(next, ctx);

      if (mode === "read-write" && ctx.hasUI) {
        const lines = [
          "[Sandbox]",
          `mode: ${mode}`,
          "write access:",
          ...buildWriteAccessLines(),
        ];
        ctx.ui.notify(lines.join("\n"), "info");
      } else {
        ctx.ui.notify(`pi-sandbox mode: ${mode}`, "info");
      }
    },
  });

  // Make the read-only restriction explicit to the model by appending a notice to the system prompt.
  // (This is in addition to hiding edit/write tools and blocking write/edit tool calls.)
  const READ_ONLY_PROMPT_MARKER = "[pi-sandbox:read-only]";
  pi.on("before_agent_start", async (event, ctx) => {
    await ensureRoot(ctx);
    if (mode !== "read-only") return;
    if (event.systemPrompt.includes(READ_ONLY_PROMPT_MARKER)) return;

    return {
      systemPrompt:
        event.systemPrompt +
        "\n\n" +
        `${READ_ONLY_PROMPT_MARKER} You are operating under pi-sandbox in READ-ONLY mode. ` +
        "Do not attempt to modify files. The edit/write tools are unavailable and any write/edit attempts will be blocked. " +
        "Only perform read-only inspection and provide recommendations without applying changes.",
    };
  });

  // Tool call enforcement for edit/write.
  pi.on("tool_call", async (event, ctx) => {
    await ensureRoot(ctx);

    if (mode === "yolo") return;

    if (isToolCallEventType("write", event)) {
      if (mode === "read-only") {
        return {
          block: true,
          reason: "pi-sandbox is in read-only mode (write blocked).",
        };
      }

      const abs = resolve(ctx.cwd, expandUserPath(event.input.path));
      const canon = await canonicalizePossiblyMissingPath(abs);
      const allowed = isPathInsideRoot(rootDirReal, canon);

      if (!allowed) {
        return {
          block: true,
          reason: `Writes are only allowed under: ${rootDirReal}\nRequested: ${event.input.path}\nResolved: ${canon}`,
        };
      }
    }

    if (isToolCallEventType("edit", event)) {
      if (mode === "read-only") {
        return {
          block: true,
          reason: "pi-sandbox is in read-only mode (edit blocked).",
        };
      }

      const abs = resolve(ctx.cwd, expandUserPath(event.input.path));
      const canon = await canonicalizePossiblyMissingPath(abs);
      const allowed = isPathInsideRoot(rootDirReal, canon);

      if (!allowed) {
        return {
          block: true,
          reason: `Edits are only allowed under: ${rootDirReal}\nRequested: ${event.input.path}\nResolved: ${canon}`,
        };
      }
    }

    return;
  });

  function buildBwrapCommand(
    userCommand: string,
    ctx: ExtensionContext,
  ): string {
    if (!bwrapPath) {
      // Security: without bwrap we can't safely sandbox bash.
      // Block instead of falling back to heuristics.
      return "";
    }

    const args: string[] = [];
    args.push(bwrapPath);
    args.push("--die-with-parent");
    args.push("--proc", "/proc");

    // Make the host filesystem visible but read-only.
    args.push("--ro-bind", "/", "/");

    // Provide a working /dev/null (and friends). Many common programs (git, sed, etc.)
    // open /dev/null for redirects or temp handling. If /dev is mounted with `nodev`,
    // those opens fail with "Permission denied". We mount an empty /dev and then
    // dev-bind only a minimal set of device nodes from the host.
    args.push("--tmpfs", "/dev");
    args.push("--dev-bind", "/dev/null", "/dev/null");
    args.push("--dev-bind", "/dev/zero", "/dev/zero");
    args.push("--dev-bind", "/dev/random", "/dev/random");
    args.push("--dev-bind", "/dev/urandom", "/dev/urandom");
    args.push("--dev-bind", "/dev/tty", "/dev/tty");
    // Common convenience symlinks.
    args.push("--symlink", "/proc/self/fd", "/dev/fd");
    args.push("--symlink", "/proc/self/fd/0", "/dev/stdin");
    args.push("--symlink", "/proc/self/fd/1", "/dev/stdout");
    args.push("--symlink", "/proc/self/fd/2", "/dev/stderr");

    // Keep the working directory consistent inside the sandbox.
    args.push("--chdir", ctx.cwd);

    if (mode === "read-write") {
      // Allow writes under sandbox root.
      args.push("--bind", rootDirReal, rootDirReal);

      // If we're in a git worktree, the real git metadata directory may live
      // outside rootDirReal (e.g. ../.git/worktrees/<name>). Git needs write
      // access there for most operations.
      for (const dir of extraWritableDirs) {
        args.push("--bind", dir, dir);
      }

      // Keep /tmp as the real host /tmp so files written there are visible to other tools
      // (e.g. the read tool) at the same path.
      // Note: this means sandboxed bash can also write to host /tmp.
      args.push("--bind", "/tmp", "/tmp");
    }

    // Execute the command.
    args.push("--", "bash", "-c", userCommand);

    // Convert argv to a host-shell command string.
    return args.map((a) => shellEscapeSingle(a)).join(" ");
  }

  // Wrap bash with sandboxing via bwrap.
  // We override the built-in bash tool (same name).
  const baseBash = createBashTool(process.cwd());
  pi.registerTool({
    ...baseBash,
    label: "bash (sandboxed)",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      await ensureRoot(ctx);

      if (mode !== "yolo") {
        if (!bwrapPath) {
          return {
            content: [
              {
                type: "text",
                text:
                  "Blocked bash command: bubblewrap (bwrap) is not available, so pi-sandbox cannot safely sandbox bash.\n\n" +
                  "Install bubblewrap (bwrap) or switch to /sandbox-mode yolo (not recommended).",
              },
            ],
            details: undefined,
          };
        }

        const wrapped = buildBwrapCommand(params.command, ctx);

        // Delegate to the built-in bash implementation.
        // Use pi's startup cwd (ctx.cwd) to avoid surprises.
        const delegate = createBashTool(ctx.cwd);
        return delegate.execute(
          toolCallId,
          { ...params, command: wrapped },
          signal,
          onUpdate,
        );
      }

      // yolo: delegate as-is.
      const delegate = createBashTool(ctx.cwd);
      return delegate.execute(toolCallId, params, signal, onUpdate);
    },
  });
}
