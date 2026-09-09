# TokenMaw

TokenMaw is a TUI-first, document-driven coding-agent runtime. The framework owns execution, tools, safety, persistence, and concurrency. Markdown Agent Specs own roles and collaboration behavior.

## Quick start

```powershell
npm install
npm run build
npm link
maw
```

Inside the TUI:

- `/provider` manages providers and credentials in one modal.
- `/model` selects the default model for the current session.
- `/agents` shows the effective Agent Specs and their sources.
- `/sessions` switches sessions; `/new` creates one.
- `/cd <path>` switches the working directory (relative paths resolve against the current one). The status bar always shows the current directory; `/cd` with no argument or `/pwd` prints it. Switching reloads the project's `.coder/agents` specs and `AGENTS.md`, and tool path authorization follows the new root.
- `!<command>` runs a shell command directly in the current workspace, outside the agent loop: the prompt turns into `$` and the command text is highlighted while typing, the command and its output stream inline into the conversation transcript (never sent to the model or fed back into context), long-running commands animate their ellipsis, and `Ctrl+C` stops a running command. `/`-commands stay reserved for the built-in slash commands.
- `Ctrl+K` opens the command palette.
- `/worktree <name>` creates (or reopens) an isolated git worktree under `.coder/worktrees/<name>` on branch `maw/<name>` and moves this session into it, so parallel sessions stop colliding on one working tree. `/worktree-list` shows status, `/worktree-exit` returns to the main checkout (the worktree stays on disk), `/worktree-remove <name>` drops a clean worktree (the branch is never deleted). A `.worktreeinclude` file copies gitignored files (e.g. `.env`) into new worktrees. Non-interactive equivalent: `maw --worktree [name]`.
- `Ctrl+B` toggles Agent Activity.
- `Ctrl+J` or `Alt+Enter` inserts a newline; `Enter` sends. Chinese text wraps by terminal width.
- `Up` / `Down` browse input history; `Ctrl+U` clears the draft.
- `PageUp` / `PageDown` scroll the conversation; `Tab` returns to the input.
- `Ctrl+Y` expands the latest tool activity.
- Click a disclosure arrow to expand Thinking, scroll with the wheel, or drag across visible conversation text to select it. `Ctrl+C` copies a selection; without a selection it exits. `Escape` clears the selection. Typing still edits the draft.
- Selected text stays stable while generation continues in the background. Copying or clearing the selection resumes display updates. Thinking is shown when the provider returns it.
- `F2` (or `/select`) optionally releases app mouse capture for the terminal's native selection. `F2` again restores app clicks, drag selection and wheel scrolling. `Ctrl+Y` and `PageUp` / `PageDown` also work without the mouse.
- `Ctrl+X` or `/cancel` stops the current session's agents; send another message to continue.
- `/compact` summarizes and archives older context of the main agent; an optional argument focuses the digest (e.g. `/compact file changes and pending work`).
- `/aside <note>` queues a side note without starting a turn; it folds into the next message you send and is announced in the conversation stream.
- `/btw <question>` opens a side conversation forked from the current session (full context included) and sends your question there. `/back` or `Ctrl+C` returns to the main conversation; side sessions are marked `[side]` in the status bar and the `/sessions` list.
- `/fork` copies the current conversation into a new saved session. `/sessions` lists both; the original stays untouched.
- `/goal <text>` sets a standing goal for the session: it is injected into every agent's prompt until cleared, shows in the status bar, and survives across sessions. `/goal clear` removes it.
- `Ctrl+C` copies a selection; without a selection it arms a quit confirmation — press again within 2 seconds to exit. Inside a side conversation, `Ctrl+C` returns to the parent session instead. Runtime errors appear in the conversation.

For a non-interactive run:

```powershell
maw run --prompt "Inspect this repository and fix the failing tests"
maw --model my-model run --prompt "Explain this repository"
```

List effective specs:

```powershell
maw agents
```

TokenMaw intentionally has no Web UI or Web server.

Interactive mode requires a terminal. Non-interactive runs report agent failures with a nonzero exit code.

## Architecture

The user talks to `main`, whose primary responsibility is responsive conversation and forward progress. Main handles small, local, and well-scoped work directly. It delegates only genuinely multi-file, ambiguous, or independently parallel work; coordinators select specialists only when that extra coordination is useful. Main remains available while background work runs and is resumed by verified agent results. The scheduler reserves user-facing capacity independently of the background concurrency limit.

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
- Each turn records requests, input/output tokens, provider-reported cached input, and first-token latency when the backend supplies them. The status bar shows the session aggregate.
- `AGENT_MAX_CHILDREN_PER_TURN` limits fan-out (default `3`); `AGENT_MAX_CONCURRENT_TURNS` and `AGENT_MAX_DEPTH` provide additional scheduler guardrails.

### Multi-process safety

Multiple `maw` processes can run against the same project without silently destroying each other's work:

- **Cross-process write locks** — every file write (`edit_file`, `write_file`) and every session is guarded by an O_EXCL lock file under `~/.coder/runtime/locks/`. Lock records carry the holder pid and process start time, so a lock left by a crashed process is detected and taken over automatically, while a live holder is reported by pid (`AGENT_SESSION_LOCK_TIMEOUT_MS` adjusts the session-lock wait, default 5s).
- **Optimistic conflict detection** — `edit_file` re-verifies inside the lock that the file still matches what the edit was based on; `write_file` refuses to overwrite a file that changed after it was read in this session. Changes from external editors or other tooling surface as explicit errors instead of silent lost updates.
- **Single writer per session** — opening a session another process is writing succeeds in read-only mode (the status bar shows `[read-only pid <n>]`); submissions, `/goal`, and `/clear` are refused with guidance. `/fork` continues from that point in a writable copy, and once the other writer exits, the session self-heals back to writable on the next message.
- **Concurrent instance awareness** — live instances register under `~/.coder/runtime/instances/`; the status bar warns when other maw processes share the workspace.
- **Managed worktrees** — for genuine parallelism, `/worktree <name>` (or `maw --worktree [name]`) isolates each session in its own checkout so conflicts become ordinary merges. Worktrees are `git worktree lock`ed while a session uses them; cleanup removes clean, unlocked ones and never touches dirty checkouts or branches.

Provider prompt caching is used when the provider supports it: runtime system prefixes stay stable and live sibling state travels through mailboxes instead of being re-injected into every request. Cross-request response caching is intentionally avoided because coding answers depend on the current workspace and tool results.

### Context compaction

Long-running agents keep their context bounded in three ways:

- **`compact_context` tool** — every agent can compact its own context (applied at the next safe tool boundary) or the context of one of its descendant agent instances (immediately, when idle). Older messages are replaced by a model-generated digest; pass `focus` to steer the digest and `keep_recent` to control the verbatim tail.
- **`search_history` tool** — compacted-away messages are archived under `~/.coder/runtime/archives/<session>/` and remain searchable by keyword, so nothing is lost for good.
- **Auto-compact** — when an instance's context exceeds ~75% of its character budget (override with `AGENT_AUTO_COMPACT_RATIO`), it compacts automatically before the next model call; hard tail truncation remains the last-resort fallback.

Visible conversation history is never modified; compaction only affects what gets sent to the model.

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
