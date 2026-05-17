# Top-tier Coding Agent CLI（TypeScript Only）

按你的要求：**现在项目只保留 TypeScript 实现，不再包含 Python 代码**。

## 安装

```bash
npm install
```

## 开发运行

```bash
npm run dev -- submit --user u1 --prompt "fix bug in parser" --mode execute
```

## Plan 模式

```bash
npm run dev -- submit --user u1 --prompt "先给我一个重构计划" --mode plan
npm run dev -- get --task <task_id>
npm run dev -- execute-plan --task <task_id>
```

## 生产构建

```bash
npm run build
npm run start -- submit --user u1 --prompt "write tests" --mode execute
```

## 环境变量

- `OLLAMA_BASE_URL`（默认 `http://localhost:11434`）
- `AGENT_MODEL`（默认 `deepseek-v4-pro:cloud`）

CLI 使用 HTTP 调用 Ollama 接口：`POST /api/chat`。

## 命令

- `submit --user <id> --prompt <text> [--mode execute|plan]`
- `get --task <task_id>`
- `execute-plan --task <task_id>`
