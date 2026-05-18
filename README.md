# pi-iuvate

Focused subagent delegation for [Pi](https://github.com/earendil-works/pi).

## Installation

```bash
pi install git:github.com/ofrades/pi-iuvate
```

## Concepts

**Iuvate** gives the main agent an `iuvate` tool for delegating focused, read-only work to route-specific subagents without changing the main session model.

| Route | When to use |
|-------|-------------|
| `search` | Fast codebase retrieval and context gathering |
| `vision` | Images and screenshots |
| `review` | Code review, security checks, regression analysis |
| `oracle` | Hard planning, architectural tradeoffs, consistency checks |
| `librarian` | External docs, unfamiliar dependencies, API research |

## Commands

### `/iuvate`

Lists and configures routes.

```text
/iuvate list
/iuvate set <route> <provider/model>
```

Examples:

```text
/iuvate set vision opencode/gemini-3.1-pro
/iuvate set oracle openai-codex/gpt-5.5
```

## Tools (for the agent)

### `iuvate`

Delegates a concrete routed task to an isolated focused subagent using the route's configured model.

```text
route: "search" | "vision" | "review" | "oracle" | "librarian"
prompt: string
image_path?: string        # for vision
```

## Configuration

Config is stored in `settings.json` under the agent directory:

```json
{
  "iuvate": {
    "routes": {
      "vision": { "provider": "opencode", "model": "gemini-3.1-pro" },
      "librarian": { "provider": "opencode", "model": "claude-sonnet-4-6" },
      "oracle": { "provider": "openai-codex", "model": "gpt-5.5" }
    }
  }
}
```

Routes without a configured `provider`/`model` are listed as `unconfigured` and will return an error if the agent tries to delegate to them.
