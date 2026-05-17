# Top-tier Coding Agent CLI/TUI

A TypeScript-based coding agent with CLI and TUI (Terminal User Interface) that connects to Ollama or any OpenAI-compatible API for AI-powered code generation, planning, and verification.

## Features

- **Execute mode** — agentic tool-use loop (read/write files, run bash)
- **Plan mode** — generate step-by-step execution plans for manual approval
- **ReAct mode** — automated plan → inspect → implement → verify pipeline
- **TUI** — interactive terminal UI with streaming output, conversation history, and task management
- **Multi-backend** — Ollama or any OpenAI-compatible API (LM Studio, Together, etc.)
- **Conversation persistence** — sessions auto-saved and can be loaded later
- **Config file** — `.agentrc` for persistent settings
- **Resilient networking** — automatic retry with backoff on connection failures

## Install

```bash
npm install
```

## CLI Usage

```bash
# Submit a task
npm run dev -- submit --user alice --prompt "add error handling" --mode execute
npm run dev -- submit --user alice --prompt "plan the refactor" --mode plan
npm run dev -- submit --user alice --prompt "implement login" --mode react

# Get task status
npm run dev -- get --task <task_id>

# Execute an approved plan
npm run dev -- execute-plan --task <task_id>
```

## TUI Usage

```bash
npm run dev -- tui
```

TUI commands:

| Command | Description |
|---------|-------------|
| `/mode <execute\|plan\|react>` | Switch agent mode |
| `/clear` | Clear conversation history |
| `/history` | Show conversation history |
| `/tasks` | List all background tasks |
| `/view <taskId>` | Inspect a task in detail |
| `/approve <taskId>` | Execute an approved plan task |
| `/model` | Show current model |
| `/resume <taskId>` | Resume a queued/running task |
| `/sessions` | List saved conversation sessions |
| `/load <sessionId>` | Load a saved conversation |
| `/help` | Show help |
| `/exit` or Ctrl+C | Quit |

## Testing

```bash
# Run all tests
npm test

# Type check without emitting
npm run typecheck
```

## REACT Mode Pipeline

1. `plan` — generate structured plan
2. `inspect_code` — explore codebase using tools
3. `write_code` — implement changes using tools
4. `verify` — run build/test commands using bash tool
5. `finalize` — collect results

## Configuration

### Environment variables

| Env var | Default | Description |
|---------|---------|-------------|
| `OLLAMA_BASE_URL` | `http://localhost:11434` | LLM server URL |
| `AGENT_MODEL` | `gemma4:31b-cloud` | Model name |
| `LLM_BACKEND` | auto-detected | `ollama` or `openai` |
| `LLM_API_KEY` | — | API key (for OpenAI-compatible backends) |

### Config file (.agentrc)

Create `.agentrc` in your project directory or home directory:

```json
{
  "baseUrl": "http://localhost:11434",
  "model": "gemma4:31b-cloud",
  "backend": "ollama",
  "defaultMode": "execute"
}
```

For OpenAI-compatible backends:

```json
{
  "baseUrl": "https://api.openai.com",
  "model": "gpt-4o",
  "backend": "openai",
  "apiKey": "sk-..."
}
```

## Skills

Built-in skill definitions for domain guidance:

| Skill | Description |
|-------|-------------|
| `python-flask` | Flask web app conventions |
| `react-component` | React + TypeScript components |
| `testing` | Test writing guidelines |
| `node-express` | Node.js Express API conventions |
| `git-workflow` | Git branching and commit conventions |
| `debugging` | Bug diagnosis methodology |
| `sql-database` | SQL and ORM guidelines |
