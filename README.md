# pi-routing

Lightweight named route switching for [Pi](https://github.com/badlogic/pi-mono).

## Installation

```bash
pi install git:github.com/ofrades/pi-routing
```

## Concepts

**Routes** are task-specific model overrides (`vision`, `handoff`, `search`, `review`, `oracle`, `librarian`). When a task needs a different capability, the agent can switch to the right model for that route and restore the previous one when done.

| Route | When to use |
|-------|-------------|
| `vision` | Images and screenshots |
| `handoff` | Context compaction and continuation prompts |
| `search` | Fast codebase retrieval and context gathering |
| `review` | Code review, security checks, regression analysis |
| `oracle` | Hard planning, architectural tradeoffs, consistency checks |
| `librarian` | External docs, unfamiliar dependencies, API research |

Routes are meant to be temporary. Use `task_model` with `action='switch'` only when you need to hand off the session to a different model, and always follow with `action='restore'` when done.

Inline one-shot delegation is intentionally not implemented here; use prompt-template/subagent extensions such as `pi-prompt-template-model` for that workflow.

## Commands

### `/routing`

Opens the interactive route selector.

```
/routing       # open selector UI
/routing on    # enable task routing
/routing off   # disable task routing
```

Inside the selector:

- `↑↓` / `j` / `k` — navigate routes
- `Enter` — switch session to selected route
- `c` — change model for selected route
- `t` — change thinking level for selected route
- `e` — toggle routing on/off
- `Esc` — cancel

## Tools (for the agent)

### `task_model`

Lists named routes or switches/restores the active session model.

```
action: "list"    — show all routes and their configured models
action: "status"  — show whether routing is enabled and the active route
action: "switch"  — switch session to a route (requires task)
action: "restore" — return to the previous/main model
task              — one of: vision, handoff, search, review, oracle, librarian
```

`pi-routing` no longer performs inline model calls itself. For one-shot delegated execution, define slash-command workflows with `pi-prompt-template-model` and/or subagents.

## Configuration

Config is stored in `settings.json` under the agent directory:

```json
{
  "routing": {
    "enabled": true,
    "routes": {
      "vision":    { "provider": "google",    "model": "gemini-2.0-flash" },
      "librarian": { "provider": "anthropic", "model": "claude-sonnet-4-6" },
      "oracle":    { "provider": "openai",    "model": "o3" }
    }
  }
}
```

Routes without a configured `provider`/`model` are listed as `unconfigured` and will return an error if the agent tries to switch to them.

## Notes

- Routing can be disabled globally. When disabled, `task_model switch` returns an error rather than silently using the wrong model.
- `thinkingLevel` defaults to the highest level supported by the configured model if not explicitly set.
- Inline route execution and image analysis are expected to come from prompt-template/subagent/model-specific extensions rather than `pi-routing`.
