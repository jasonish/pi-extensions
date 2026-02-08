# pi-default-model

A small Pi extension that lets you save your **current model + thinking level** as the startup default.

On each new session, it reads `startupModel` from settings and applies it automatically.

## Command

### `/set-default-model`

Set or clear the saved startup model.

Examples:

```text
/set-default-model
/set-default-model --project
/set-default-model --clear
/set-default-model --clear --project
/set-default-model --help
```

Behavior:

- No flags: save current model + thinking level as **global** default.
- `--project`: save as **project** default in `.pi/settings.json`.
- `--clear`: remove the saved default (global by default, or project with `--project`).

## Where it stores settings

- Global: `~/.pi/agent/settings.json`
- Project: `.pi/settings.json`

Stored shape:

```json
{
  "startupModel": {
    "model": "provider/model-id",
    "thinkingLevel": "off|minimal|low|medium|high|xhigh"
  }
}
```

> Note: legacy string form is also read (`"startupModel": "provider/model-id"`).

## Typical workflow

1. Pick your model and thinking level in Pi.
2. Run `/set-default-model`.
3. Start a new session — the extension applies that model/thinking automatically.
