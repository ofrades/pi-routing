# pi-routing

Experimental lightweight named route delegation for [Pi](https://github.com/earendil-works/pi), inspired by [Amp](https://ampcode.com/models)-style focused subagents.

## Installation

```bash
pi install git:github.com/ofrades/pi-routing
```

`task_delegate` runs focused subagents as isolated `pi --mode json --no-session` subprocesses; no separate subagent package is required.

## Concepts

**Routes** are task-specific subagent model overrides (`eagle`, `search`, `review`, `oracle`, `librarian`). When a task needs a different capability, `task_delegate` starts an isolated fresh subagent with the right route model.

| Route | When to use |
|-------|-------------|
| `eagle` | Images and screenshots |
| `search` | Fast codebase retrieval and context gathering |
| `review` | Code review, security checks, regression analysis |
| `oracle` | Hard planning, architectural tradeoffs, consistency checks |
| `librarian` | External docs, unfamiliar dependencies, API research |

Use `task_delegate` for one-shot routed work. The main session model is not changed.

For image file paths, use the `describe_image` tool. The eagle route must be configured to a model that advertises image input.

## Commands

### `/routing`

Lists and configures routes.

```
/routing list
/routing set <route> <provider/model>
```

Examples:

```bash
/routing set eagle google/gemini-2.0-flash
/routing set oracle openai/o3
```

## Tools (for the agent)

### `task_delegate`

Delegates a concrete routed task to an isolated focused subagent using the route's configured model, without changing the main session model. The subagent runs as a fresh `pi --mode json --no-session` subprocess.

```
route: "search" | "review" | "oracle" | "librarian" | "eagle"
prompt: string                 # concrete task for the child agent
cwd?: string                   # default: current cwd
```

Each route uses its own focused system prompt and configured model.

Delegated subagents use read-only local tools by default (`read`, `grep`, `find`, `ls`). The `search`, `review`, and `librarian` routes also get `bash` so the model can use read-oriented commands such as `git diff`, `rg`, or `curl` when needed. No bundled web-search API is used.


## Configuration

Config is stored in `settings.json` under the agent directory:

```json
{
  "routing": {
    "routes": {
      "eagle":     { "provider": "google",    "model": "gemini-2.0-flash" },
      "librarian": { "provider": "anthropic", "model": "claude-sonnet-4-6" },
      "oracle":    { "provider": "openai",    "model": "o3" }
    }
  }
}
```

Routes without a configured `provider`/`model` are listed as `unconfigured` and will return an error if the agent tries to delegate to them.

## Notes

- `task_delegate` runs `pi --mode json -p --no-session` with the route model and route tool allowlist.
- `describe_image` uses the configured `eagle` route for image file descriptions.
- `thinkingLevel` defaults to the highest level supported by the configured model if not explicitly set.
- `task_delegate` uses isolated focused subagents and does not require `pi-subagents`.
