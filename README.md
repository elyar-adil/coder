# Coder

Coder is a TUI-first, document-driven coding-agent runtime. The framework owns execution, tools, safety, persistence, and concurrency. Markdown Agent Specs own roles and collaboration behavior.

## Quick start

```powershell
npm install
npm run build
npm link
coder
```

Inside the TUI:

- `/provider` manages providers and credentials in one modal.
- `/model` selects the default model for the current session.
- `/agents` shows the effective Agent Specs and their sources.
- `/sessions` switches sessions; `/new` creates one.
- `Ctrl+K` opens the command palette.
- `Ctrl+B` toggles Agent Activity.

For a non-interactive run:

```powershell
coder run --prompt "Inspect this repository and fix the failing tests"
```

List effective specs:

```powershell
coder agents
```

Coder intentionally has no Web UI or Web server.

## Architecture

The user talks only to a lightweight `main` agent. Simple conversation stays with main; complex work is handed to one or more coordinator agents. Coordinators select specialist agents themselves.

```text
user ↔ main → coordinator(s) → explorer / implement / review / custom agents
```

The runtime does not contain role-specific routing or planner branches. `main`, `coordinator`, and specialists are all ordinary persistent AgentInstances with mailboxes. A user message is a Session message, not a task.

See [docs/architecture-revision.md](docs/architecture-revision.md) for the complete design and implementation status.

## Agent Specs

Specs are loaded with project-first effective precedence:

1. built-in `agents/**/*.md`
2. user `~/.coder/agents/**/*.md`
3. project `.coder/agents/**/*.md`

Later roots replace an earlier spec with the same relative ID.

```md
---
description: Coordinates frontend work
model: strong
tools: []
agents:
  - explorer
  - implement
  - review/*
---

Coordinate the requested frontend work. Delegate independent investigation in
parallel and return verified results to the parent agent.
```

Fields:

- `description` is required and is shown to agents choosing whom to call.
- `model` is an optional `.agentrc` alias; omitted or `inherit` uses the session model.
- `tools` accepts exact tool names or `*`.
- `agents` accepts exact IDs, namespace selectors such as `review/*`, `*`, or `[]`.

Specs can reduce capabilities but cannot bypass global tool policy, path boundaries, concurrency, timeout, or recursion limits.

## Runtime behavior

- One persistent main instance per Session.
- Agent instances retain their own model history and mailbox.
- `spawn_agent`, `send_agent`, `wait_agent`, and `cancel_agent` are generic runtime primitives.
- Related work can reuse an existing coordinator; unrelated coordinators can run concurrently.
- New user input interrupts only main's current generation. Background agents keep running until main explicitly redirects or cancels them.
- Only main output enters the user-visible conversation.
- Sessions and instances persist under `~/.coder/runtime/` and recover after restart.

## Model configuration

Provider and model configuration is stored in the user-level `~/.agentrc`. Project configuration may provide defaults, while interactive changes remain user-scoped.

```json
{
  "model": "fast",
  "models": {
    "fast": {
      "backend": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "model": "gpt-5-mini",
      "apiKey": "..."
    },
    "strong": {
      "backend": "anthropic",
      "baseUrl": "https://api.anthropic.com",
      "model": "claude-sonnet-4-5",
      "apiKey": "..."
    }
  }
}
```

Agent-specific model choice belongs in its Markdown spec. The retired Reception/Brain/Worker role-model mapping is no longer supported.

## Development

```powershell
npm run typecheck
npm test
npm run build
```

The project uses TypeScript, Node.js ESM, Blessed for the TUI, and provider-neutral tool definitions for OpenAI-compatible, Anthropic, and Ollama backends.
