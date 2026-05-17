# Top-tier Coding Agent CLI/TUI（TypeScript Only）

你提的点都补上了：

- 解释了 `user_id` 含义。
- 增加了 **TUI 交互界面**。
- 增加了 **REACT 模式**（plan → 看代码 → 写代码 → 验证 → 总结）。

## user_id 是什么

`user_id` 是任务归属标识（owner label），用于区分不同用户/会话提交的任务，便于 master 统一追踪与隔离统计。

## 安装

```bash
npm install
```

## CLI 使用

```bash
npm run dev -- submit --user alice --prompt "fix bug in parser" --mode execute
npm run dev -- submit --user alice --prompt "给我方案" --mode plan
npm run dev -- submit --user alice --prompt "实现完整功能" --mode react
npm run dev -- get --task <task_id>
npm run dev -- execute-plan --task <task_id>
```

## TUI 使用

```bash
npm run dev -- tui
```

进入后可用命令：

- `new`：创建任务（execute/plan/react）
- `list`：查看任务列表
- `view`：查看任务详情（含 phaseEvents）
- `approve`：批准并执行 plan 任务
- `help` / `exit`

## REACT 模式流程

在 `react` 模式下，系统会自动按阶段推进并记录 `phaseEvents`：

1. `plan`
2. `inspect_code`
3. `write_code`
4. `verify`
5. `finalize`

## 模型配置

- `OLLAMA_BASE_URL`（默认 `http://localhost:11434`）
- `AGENT_MODEL`（默认 `deepseek-v4-pro:cloud`）

通过 HTTP 调用 Ollama：`POST /api/chat`。
