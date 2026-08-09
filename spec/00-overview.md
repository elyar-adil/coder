# Coder 项目规格说明文档

## 1. 项目概述

### 1.1 项目名称
**top-tier-coding-agent-cli** (简称 Coder)

### 1.2 项目定位
一个基于 TypeScript 构建的**异步多智能体编码系统**，为开发者提供 AI 驱动的代码编写、调试和项目管理能力。

### 1.3 核心特性
- **三端统一**：CLI 命令行、TUI 交互终端、Web 浏览器界面
- **多后端支持**：OpenAI 兼容 API、Anthropic Messages API、Ollama 本地模型
- **智能路由**：自动判断用户意图，决定直接回复或创建任务
- **多智能体协作**：主协调器 → 工作者 → 子智能体的层级架构
- **增量式代码编辑**：结构化补丁系统，支持冲突检测和验证
- **会话持久化**：任务和对话历史自动保存，支持断点续传

### 1.4 技术栈

| 层级 | 技术 |
|------|------|
| 编程语言 | TypeScript (ES2022, 严格模式) |
| 运行时 | Node.js (ESM) |
| CLI 框架 | Commander.js |
| 终端 UI | 原生 readline + chalk |
| Web UI | Node.js HTTP + SSE + 单页 HTML |
| LLM 后端 | Ollama (NDJSON) / OpenAI (SSE) / Anthropic (SSE) |
| 构建工具 | tsc (TypeScript 编译器) |
| 开发运行 | tsx |
| 测试框架 | Node.js 内置 test runner |

### 1.5 项目结构

```
src/
├── cli.ts                  # CLI 入口点
├── config.ts               # .agentrc 配置加载/保存
├── config-command.ts       # 交互式模型配置向导
├── backend.ts              # LLM 后端抽象层
├── fetch.ts                # 带重试的 HTTP 客户端
├── model-config.ts         # 模型配置解析
├── policy.ts               # 工具调用策略
├── store.ts                # 任务/对话持久化
├── subagentManager.ts      # 子智能体并发管理
├── telemetry.ts            # 遥测事件存储
├── diff.ts                 # 差异生成器
├── markdown.ts             # 终端 Markdown 渲染
├── domain/
│   └── task.ts             # 核心类型定义
├── runtime/
│   ├── coordinator.ts      # 主协调器（核心）
│   ├── planner.ts          # 计划解析
│   └── locks.ts            # 文件锁管理
├── infra/
│   ├── tools.ts            # 工具定义与执行
│   └── prompts.ts          # 系统提示词
├── ui/
│   ├── tui.ts              # 终端 UI
│   ├── web.ts              # Web 服务器
│   └── public/
│       └── index.html      # Web 前端 SPA
└── types/
    └── unicode-width.d.ts  # 类型声明
```

## 2. 版本信息

- **当前版本**：0.2.0
- **许可证**：项目私有
- **Node.js 要求**：ES2022+
