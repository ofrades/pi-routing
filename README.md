# pi-routing

Experimental lightweight named route switching for [Pi](https://github.com/earendil-works/pi) trying something like [amp](https://ampcode.com/models) subagents and system models but for cheaper runs.

## Installation

```bash
pi install git:github.com/ofrades/pi-routing
```

`task_delegate` runs built-in focused subagents internally; no separate subagent package is required.

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

For immediate one-shot work, use `task_delegate` to run an internal focused subagent, or define slash-command workflows with `pi-prompt-template-model`.

Image requests are auto-routed before the model turn starts when routing is enabled and the user prompt includes attached images or image file paths such as `/tmp/pi-clipboard-....png`. The vision route must be configured to a model that advertises image input.

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

### `task_delegate`

Delegates a concrete routed task to an internal focused subagent using the route's configured model, without changing the main session model.

```
task: "search" | "review" | "oracle" | "librarian" | "handoff" | "vision"
prompt: string                 # concrete task for the child agent
agent?: string                 # override subagent name
context?: "fresh" | "fork"    # default: fresh
cwd?: string                   # default: current cwd
```

Default route-to-agent mapping (AmpCode-style naming):

| Route | Default subagent |
|-------|------------------|
| `search` | `search` |
| `review` | `review` |
| `oracle` | `oracle` |
| `librarian` | `librarian` |
| `handoff` | `handoff` |
| `vision` | `vision` |

Use `context: "fresh"` for cost-effective targeted work. Use `context: "fork"` only when the child needs the current conversation context.

Delegated subagents use read-only local tools by default (`read`, `grep`, `find`, `ls`). The `search` and `librarian` routes also get `bash` so the model can use available CLI/network tools such as `curl` when external information is needed. No bundled web-search API is used.

### `task_model`

Lists named routes or switches/restores the active session model.

```
action: "list"    — show all routes and their configured models
action: "status"  — show whether routing is enabled and the active route
action: "switch"  — switch session to a route (requires task)
action: "restore" — return to the previous/main model
task              — one of: vision, handoff, search, review, oracle, librarian
```

`task_model switch` changes the main session model for the next turn. For immediate one-shot work, use `task_delegate` or define slash-command workflows with `pi-prompt-template-model`.

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
- Image prompts are auto-routed to `vision` in the input/before-agent-start path, so the switch applies to the current image turn instead of the next turn.
- `thinkingLevel` defaults to the highest level supported by the configured model if not explicitly set.
- `task_delegate` uses internal focused subagents and does not require `pi-subagents`.
