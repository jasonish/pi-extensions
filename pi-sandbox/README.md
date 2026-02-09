# @jasonish/pi-sandbox

A security-focused sandbox extension for the pi coding agent.

`pi-sandbox` adds runtime guardrails around tool execution with three modes:

- `read-only` — blocks `edit`/`write` and sandboxes `bash` for read-only access
- `read-write` — allows edits/writes only under the directory where pi was started
- `yolo` — disables restrictions

## Features

- Enforces write boundaries for `edit` and `write`
- Wraps `bash` in `bubblewrap` (`bwrap`) in non-`yolo` modes
- Optional git metadata passthrough so worktree git operations can still work in `read-write`
- Session status + mode switching command/shortcut

## Installation

```bash
npm install -g @jasonish/pi-sandbox
```

Or add it where you manage your pi extensions.

## Requirements

- Linux
- `bubblewrap` (`bwrap`) available at:
  - `/usr/bin/bwrap` or
  - `/bin/bwrap`

If `bwrap` is missing, sandboxed `bash` execution is blocked unless you switch to `yolo`.

## Usage

### CLI flag

```bash
pi --sandbox-mode read-write
```

Supported values:

- `read-only`
- `read-write` (default)
- `yolo`

Aliases accepted by the extension:

- `readonly`, `ro`
- `readwrite`, `rw`

### In-session command

```text
/sandbox-mode
```

or

```text
/sandbox-mode read-only
/sandbox-mode read-write
/sandbox-mode yolo
```

### Shortcut

- `Ctrl+X` cycles modes:
  - `read-only` → `read-write` → `yolo` → ...

## Security model

### read-only

- `edit` and `write` are blocked
- `bash` runs in a read-only filesystem sandbox
- `write` access via tools: none

### read-write

- `edit`/`write` allowed only under the startup root directory (recursive)
- `bash` can write to:
  - startup root directory
  - `/tmp`
  - required git metadata dirs (when applicable)

### Git/worktree discovery (read-write mode)

To keep `git` usable in constrained environments, `pi-sandbox` discovers git metadata at session start:

1. It checks for a `.git` entry in the startup root.
2. It verifies the directory is inside a work tree.
3. It resolves:
   - `git rev-parse --absolute-git-dir`
   - `git rev-parse --path-format=absolute --git-common-dir`
4. If either resolved directory is outside the sandbox root, it is added as an extra writable bind for sandboxed `bash` in `read-write` mode.

Important behavior:

- This is only granted when pi starts at a worktree root (where `.git` exists in the startup root).
- If pi is started in a subdirectory of a larger repo, writes outside the startup root are intentionally **not** granted.
- Nested/duplicate git metadata paths are de-duplicated.

### yolo

- No restrictions

## Notes

- Boundary checks canonicalize paths to reduce symlink/path traversal escapes.

## Disclaimer

Use this extension at your own risk.

`pi-sandbox` is primarily meant to prevent accidental writes outside your project directory. It is **not** a guarantee of complete isolation and is **not** a replacement for stronger sandboxing (for example, running inside a container or virtual machine).

If a sandbox break occurs, responsibility for validating and securing your runtime environment remains with the user/operator.

## License

MIT
