# pi-default-model

A small Pi extension that lets you save your **current model + thinking level** as the startup default.

On each new session, it reads `startupModel` from settings and applies it automatically.

## Commands

### `/set-default-model`
Save the currently active model and thinking level to **global** `startupModel`.

Examples:

```text
/set-default-model
/set-default-model --help
```

### `/set-project-default-model`
Save the currently active model and thinking level to **project** `startupModel` (`.pi/settings.json`).

### `/set-default-model-project`
Alias for `/set-project-default-model`.

### `/startup-model [--global|--project] [show|clear]`
Inspect or clear the saved startup setting.

Examples:

```text
/startup-model
/startup-model --project
/startup-model clear
/startup-model --project clear
/startup-model --help
```

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
