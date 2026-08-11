# TUI-first Coding Agent

A TypeScript coding agent centered on an interactive terminal UI. It connects to OpenAI-compatible, Anthropic, or local NDJSON chat APIs for asynchronous code generation, planning, and verification.

## Features

- **Instant prompt dispatch** — every prompt becomes a task immediately; the UI stays usable while routing, planning, execution, and verification continue in the background
- **Cross-task coordination** — follow-up prompts can query a running task, change a task through its mailbox, or start derived/sync work from existing task context
- **Embeddable tool system** — provider-neutral definitions, registry-based execution, policy controls, repository search, file operations, Git inspection, shell execution, and coordinator capabilities
- **Execute mode** — planner-driven agentic execution; the planner chooses direct answer, bash, read-only inspection, code edits, and verification steps dynamically
- **Plan mode** — generate step-by-step execution plans for manual approval
- **ReAct mode** — compatibility alias for planner-driven execution
- **TUI** — interactive terminal UI with streaming output, conversation history, session-scoped task management, and numbered clarification choices
- **Choice-based clarification** — agents ask concrete selectable options; arbitrary free-form clarification answers are rejected so blocked tasks resume from explicit user choices
- **Writer patch pipeline** — workers submit structured patches with base hashes and verification commands; the writer applies them under file locks and reports conflicts without clobbering concurrent work
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

When an agent needs clarification, the TUI prints numbered options. Reply with a number such as `1`; any other prompt starts or routes normal work instead of being consumed as the answer.

## Testing

```bash
# Run all tests
npm test

# Type check without emitting
npm run typecheck
```

## Planner-Driven Execution

For each prompt, the planner first creates dynamic steps. Simple questions can be answered directly, exact calculations can use `bash`, repository inspection can stay read-only, and code changes can include edit and verification steps. There is no fixed design phase unless the planner decides a design step is actually needed.

## Asynchronous Coordination

Prompts are accepted before routing finishes, so a slow model call never blocks the next prompt. The master router inspects current task snapshots and chooses one of several actions:

- `new_task` starts independent work.
- `query_task` answers from task state without changing the task.
- `update_task` appends a requirement to the target task mailbox; running tasks absorb mailbox updates and replan.
- `derived_task` and `sync_task` create new work with shared context from related tasks.
- `clarify_target` asks the user to choose from concrete target-task options when multiple tasks match.

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
  "policyLevel": "moderate",
  "artifactsDir": ".agent-workspace/artifacts"
}
```

`artifactsDir` controls where Web sessions create per-session temporary artifact folders. Relative paths are resolved from the workspace. Generated deliverables should go there unless the user explicitly asks for another output path or the task is editing repository code.

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
