# Top-tier Coding Agent CLI/TUI

A TypeScript-based coding agent with CLI and TUI (Terminal User Interface) that connects to OpenAI-compatible, Anthropic, or local NDJSON chat APIs for AI-powered code generation, planning, and verification.

## Features

- **Execute mode** — planner-driven agentic execution; the planner chooses direct answer, bash, read-only inspection, code edits, and verification steps dynamically
- **Plan mode** — generate step-by-step execution plans for manual approval
- **ReAct mode** — compatibility alias for planner-driven execution
- **TUI** — interactive terminal UI with streaming output, conversation history, and task management
- **Multi-backend** — OpenAI-compatible APIs, Anthropic, and local NDJSON-compatible runtimes
- **Conversation persistence** — sessions auto-saved and can be loaded later
- **Config file** — `.agentrc` for persistent settings
- **Resilient networking** — automatic retry with backoff on connection failures

## Install

```bash
npm install
npm run build
npm link   # globally installs `coder` command
```

## CLI Usage

```bash
# Submit a task
coder submit --user alice --prompt "add error handling" --mode execute
# or in development
npm run dev -- submit --user alice --prompt "add error handling" --mode execute
npm run dev -- submit --user alice --prompt "plan the refactor" --mode plan
npm run dev -- submit --user alice --prompt "implement login" --mode react

# Get task status
coder get --task <task_id>
# or
npm run dev -- get --task <task_id>

# Execute an approved plan
coder execute-plan --task <task_id>
# or
npm run dev -- execute-plan --task <task_id>
```

## TUI Usage

```bash
coder
# or
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
| `/model` | Open model picker and persist selection |
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

## Planner-Driven Execution

For each prompt, the planner first creates dynamic steps. Simple questions can be answered directly, exact calculations can use `bash`, repository inspection can stay read-only, and code changes can include edit and verification steps. There is no fixed design phase unless the planner decides a design step is actually needed.

## Configuration

### Environment variables

| Env var | Default | Description |
|---------|---------|-------------|
| `LLM_BASE_URL` | `http://localhost:11434` | LLM server URL |
| `OLLAMA_BASE_URL` | legacy alias | Backward-compatible alias for `LLM_BASE_URL` |
| `AGENT_MODEL` | `gemma4:31b-cloud` | Model name |
| `LLM_BACKEND` | auto-detected | `openai`, `anthropic`, or `ollama` |
| `LLM_API_KEY` | — | API key (for OpenAI-compatible backends) |

For `openai` backends, `baseUrl` may be either the API root (`https://api.openai.com`) or a `/v1` URL (`https://gateway.example/v1`). The client normalizes both forms and sends requests to `/v1/chat/completions`.

### Config file (.agentrc)

Create `.agentrc` in your project directory or home directory:

```json
{
  "baseUrl": "http://localhost:11434",
  "model": "gemma4:31b-cloud",
  "backend": "openai",
  "defaultMode": "execute",
  "policyLevel": "moderate"
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

For Anthropic backends:

```json
{
  "baseUrl": "https://api.anthropic.com",
  "model": "claude-sonnet-4-20250514",
  "backend": "anthropic",
  "apiKey": "sk-ant-..."
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


## Benchmarks

The project now includes a benchmark catalog at `tests/benchmarks/benchmark_catalog.json` covering SWE-bench Lite, HumanEval, MBPP, APPS, and LiveCodeBench and a runnable isolated-checkout harness under `tests/benchmarks/harness.ts`.


### Run benchmark harness

```bash
npm run eval:bench
# optional: custom tasks and output
# npm run eval:bench -- tests/benchmarks/tasks.sample.json tests/benchmarks/reports/custom.json
```
