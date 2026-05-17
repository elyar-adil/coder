# Top-tier Coding Agent CLI/TUI

A TypeScript-based coding agent with CLI and TUI (Terminal User Interface) that connects to Ollama for AI-powered code generation, planning, and verification.

## Features

- **Execute mode** — agentic tool-use loop (read/write files, run bash)
- **Plan mode** — generate step-by-step execution plans for manual approval
- **ReAct mode** — automated plan → inspect → implement → verify pipeline
- **TUI** — interactive terminal UI with streaming output, conversation history, and task management

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
| `/help` | Show help |
| `/exit` or Ctrl+C | Quit |

## Testing

```bash
# Run all TypeScript tests
npm test

# Run Tetris Python tests
npm run test:tetris

# Run all tests
npm run test:all

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

| Env var | Default | Description |
|---------|---------|-------------|
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server URL |
| `AGENT_MODEL` | `gemma4:31b-cloud` | Model name |

Uses Ollama HTTP API: `POST /api/chat`
