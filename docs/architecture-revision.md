# Agent Runtime Architecture

> 状态：核心实现已完成，持续验收中
>
> 更新日期：2026-08-30
>
> 目标版本：0.3.0

## 1. 为什么重构

当前实现把 agent 的组织方式写死在 TypeScript 中：`MasterCoordinator` 同时承担接待、路由、规划、执行、展示、任务管理和子 agent 调度，`RouteAction`、planner intent、Reception/Brain/Worker 模型角色以及大量条件分支共同定义了一条固定工作流。

这造成了三个直接问题：

1. 普通用户消息也被创建成独立任务，连续对话变成任务管理器。
2. 新增或改变一种 agent 协作方式必须修改 Runtime 代码。
3. main agent 要等待复杂路由和规划，无法快速回应用户。

本次重构将项目定位为通用的 **Agent Framework / Actor Runtime**。代码提供执行机制；agent 是什么、可以调用谁、应该如何协作，由 Markdown Agent Spec 定义，并由 LLM 在运行时自主决策。

## 2. 已确认的设计

### 2.1 总体结构

```text
用户
  ↕
main agent（轻量入口、快速响应、唯一用户出口）
  ↕
一个或多个 coordinator agent（复杂推理与协调）
  ↕
explorer / implement / review / 项目自定义 agents
```

- `main` 只负责用户交互、简单问题和快速委派，不承担复杂协调。
- 默认倾向复用一个 coordinator；面对多套复杂且无关的工作，main 可以启动多个 coordinator 并行处理。
- coordinator 根据自己的 spec 自主决定调用哪些 specialist、是否并行、何时追问或取消。
- 所有 agent 结果都必须经过 main 才能展示给用户。
- main、coordinator 和 specialist 在 Runtime 中是同一种 AgentInstance，不存在代码级角色特权。

### 2.2 Runtime 与 Spec 的边界

Runtime 只负责不可绕过的机制：

- Agent Spec 的发现、解析、覆盖与权限校验
- 模型调用、流式输出和上下文裁剪
- AgentInstance 的创建、调度、mailbox、暂停与取消
- 并发、超时、最大调用深度和循环保护
- 文件工具、Shell 策略、路径边界、文件锁和原子写入
- Session、消息、运行实例和事件的持久化及崩溃恢复

Agent Spec 负责可变化的策略：

- agent 的职责和行为说明
- 使用哪个模型
- 可以使用哪些工具
- 可以调用哪些具体 agent 或 agent 命名空间
- 何时委派、复用、并行、汇总和回应

Runtime 不得包含 router、planner、writer、reviewer 等角色语义，也不得根据 agent 名称进入特殊代码分支。唯一的入口约定是 Session 从名为 `main` 的 spec 启动。

## 3. Agent Spec

### 3.1 发现和覆盖

Agent Spec 按以下顺序加载，后者同名整体覆盖前者：

1. 包内置：`agents/**/*.md`
2. 用户级：`~/.coder/agents/**/*.md`
3. 项目级：`.coder/agents/**/*.md`

Agent ID 取相对于 agents 根目录的路径并移除 `.md`。例如：

```text
.coder/agents/review/security.md → review/security
```

### 3.2 文件格式

```md
---
description: 快速接收用户输入并委派复杂工作
model: fast
tools: []
agents:
  - coordinator
  - coordinator/*
---

你是用户的直接交互入口……
```

字段约束：

- `description`：必填，向可调用该 agent 的 LLM 描述其能力。
- `model`：可选；模型 alias 或 `inherit`。省略时继承 Session 默认模型。
- `tools`：具体工具名列表或 `*`。Spec 只能缩小权限，不能突破全局安全策略。
- `agents`：允许调用的 agent 选择器列表。

Agent 选择器支持：

- `explorer`：允许一个具体 agent。
- `review/*`：允许一个命名空间。
- `*`：允许所有已注册 agent。
- `[]`：禁止调用其他 agent。

Runtime 只把匹配后的 agent ID 和 description 注入当前 agent 上下文；目标 agent 的完整正文仅在实际调用时加载。

## 4. Actor 执行模型

### 4.1 核心实体

- **Session**：一段持续的用户对话，拥有一个持久 main instance。
- **AgentInstance**：某个 Agent Spec 的有状态运行实例，保留独立消息历史和 mailbox。
- **Turn**：AgentInstance 因一条输入被唤醒后进行的一轮模型与工具循环。
- **Event**：面向 TUI 和持久化层的增量状态变化。

用户每次输入只创建 Session message 和 Turn，不创建 Task。

AgentInstance 状态使用：

- `queued`：等待调度
- `running`：正在执行模型或工具
- `idle`：本轮完成，可以继续接收消息
- `waiting`：等待其他 agent 的结果
- `failed`：本轮失败，实例仍保留上下文
- `cancelled`：实例已关闭

### 4.2 Agent 生命周期原语

对有 agent 调用权限的 LLM 暴露统一工具：

- `spawn_agent(agent, message)`：创建实例并返回 instance ID。
- `send_agent(instanceId, message)`：向已有实例发送补充、修正或结果。
- `wait_agent(instanceIds)`：等待一个或多个实例产生结果或进入 idle。
- `cancel_agent(instanceId)`：中断并关闭实例。

消息是双向的。父 agent 可以向子 agent 发要求，子 agent 可以向父 agent 汇报。子消息到达 idle 的父 agent 时，Runtime 自动唤醒父 agent。

默认约束：

- 全局同时执行的 Turn 上限为 4。
- agent 嵌套深度上限为 4。
- 禁止调用祖先链中已存在的 agent，避免递归环。
- 子 agent 默认只收到自己的 spec、调用消息、工作区元数据和显式传入的上下文，不复制完整用户会话。

## 5. 用户交互语义

### 5.1 首次响应

main 使用轻量模型。复杂请求到达时，main 应立即给出自然、简短的确认，同时启动或通知 coordinator，不等待复杂推理完成。

### 5.2 连续输入和纠正

main 正在生成时用户继续输入：

1. Runtime 中断当前 main 模型生成。
2. 新消息追加到同一个 Session。
3. 已启动的 coordinator 和 specialist 保持运行。
4. main 根据新上下文决定补充现有 coordinator、取消它或启动新的 coordinator。

### 5.3 输出边界

- 只有 Session 的 main instance 可以产生用户可见文本。
- coordinator 和 specialist 的进展与结果写入 main mailbox。
- main 被 mailbox 唤醒后决定是否立即通知用户以及如何表达。

## 6. TUI 设计

Web UI 将被完全删除，项目只保留现代化 TUI。

TUI 不再模拟任务管理器，而采用现代桌面聊天应用布局：

```text
┌ Coder · session · model ───────────────────────────────┐
│                                                        │
│  对话时间线                                             │
│  用户与 main 的消息、流式输出、轻量状态提示              │
│                                                        │
├───────────────────────────────┬────────────────────────┤
│ composer                      │ Agent Activity         │
│ 输入、快捷提示、当前状态       │ 可折叠运行树和工具活动   │
└───────────────────────────────┴────────────────────────┘
```

视觉与交互要求：

- 减少粗重边框，使用留白、层次色、弱分隔线和统一状态色。
- 对话是主区域，Agent Activity 是次要且可隐藏的侧栏。
- activity 以父子树展示 instance，不产生任务卡。
- 流式内容原位更新，避免整屏闪烁。
- 输入框始终可用；运行中的 agent 不阻塞继续输入。
- `/provider` 打开统一 provider 管理弹窗。
- `/model` 打开模型选择弹窗。
- `/agents` 展示实际生效的 spec、来源、模型和权限。
- `/sessions` 管理会话；`/new` 新建会话；`/clear` 清空当前对话。
- `Ctrl+K` 打开命令面板，`Ctrl+B` 显示或隐藏 Agent Activity。

## 7. 配置、存储和 CLI

- 删除 `reception/brain/worker` 和 `roleModels`。
- `/model` 设置 Session 默认模型；Agent Spec 的 `model` 可以覆盖它。
- 保留 `/provider` 的用户级 provider 配置。
- 默认执行 `coder` 进入 TUI。
- 提供 `coder run --prompt <text>` 作为一次性非交互会话。
- 删除 `coder web`、Web API、SSE、静态前端和 Web 测试。
- 删除旧 `submit/get/execute-plan` 任务协议。

新数据写入 `~/.coder/runtime/`：

- Session 与用户可见消息
- AgentInstance 元数据和独立历史
- mailbox 与运行状态
- 可重放事件

旧 `~/.coder/tasks` 不再加载，也不自动删除。旧 conversation 文件可以只读迁移，历史里的 `taskId` 字段忽略。

## 8. 内置 Agent Specs

首版内置以下 Markdown 文档，不设置任何代码特权：

- `main`：快速用户交互、简单回答、选择或复用 coordinator。
- `coordinator`：复杂目标理解、工作拆分、协调和向 main 汇报。
- `explorer`：只读代码调查。
- `implement`：代码修改与验证。
- `review`：只读审查与风险检查。

项目和用户可以覆盖任何内置定义，也可以增加 `coordinator/frontend`、`coordinator/backend` 等命名空间。

## 9. 当前状态与实施清单

### 9.1 当前仍然存在的旧实现

截至本文更新时，以下旧实现已处理：

- [x] `MasterCoordinator` 已替换为通用 `AgentRuntime`。
- [x] 每条 prompt 改为 Session message + Turn，不再创建 `PromptTask`。
- [x] router、planner、presentation、writer 等固定流程已从编译树删除。
- [x] `roleModels` 和 Reception/Brain/Worker 配置已移除；模型由 Agent Spec 决定。
- [x] TUI 已改为现代对话布局，Activity 作为可折叠侧栏。
- [x] Web 服务、Web API 和静态前端已删除。
- [x] Agent Spec 注册表和 Actor Runtime 已实现。

### 9.2 实施顺序

1. [x] 建立 Agent Spec 类型、解析器、三层 Registry 和选择器权限测试。
2. [x] 建立 Session、AgentInstance、mailbox、事件和原子持久化。
3. [x] 实现模型/工具循环及 `spawn/send/wait/cancel` 原语。
4. [x] 实现 main 中断续聊、后台 agent 保持运行及 mailbox 唤醒。
5. [x] 添加五个内置 Agent Specs。
6. [x] 将 CLI 和现代 TUI 切换到新 Runtime。
7. [x] 删除 Web、旧 coordinator/planner/task 工作流和角色模型配置。
8. [x] 更新 README、测试和 benchmark 入口。
9. [x] 执行 typecheck、build、全量测试并重新全局链接 `coder`。

以上清单表示本轮已完成。仍未完成的长期事项单独列在下一节，不得把它们误读为已实现。

### 9.3 仍未完成或需要后续加强

- [ ] AgentInstance 目前按 Session 快照持久化，尚未拆成独立 append-only 日志；多进程并发写仍不在支持范围。
- [ ] Agent Spec 解析器是受限 YAML frontmatter，不是完整 YAML 兼容实现；复杂 YAML 结构需后续扩展。
- [ ] 全局工具安全仍由现有进程级 policy 负责，尚未提供 OS 级沙箱。
- [ ] main 的“相关工作复用还是新建 coordinator”由 LLM/spec 决定，Runtime 尚未提供语义相似度或去重兜底。
- [ ] TUI 已现代化但仍是 Blessed 单体界面，尚未拆成可复用组件；暂不提供 Web 客户端。
- [ ] 多用户、多进程服务化和远程 agent 执行尚未实现。
- [ ] Agent 级 token/cost 统计和完整 trace 导出尚未实现。

## 10. 验收标准

- 连续输入十条普通消息，Session 中增加十条消息，但不出现十个任务。
- main 可以在 coordinator 完成前先向用户输出自然回应。
- 相关补充会发给现有 coordinator；main 也能为无关复杂工作启动第二个 coordinator。
- coordinator 可以只依靠 spec 描述选择并调用 specialist，Runtime 中不存在角色名称分支。
- 项目、用户和内置 spec 的覆盖顺序正确。
- agent 精确选择器、命名空间选择器、`*` 和空权限均被 Runtime 强制执行。
- 用户中途输入会中断 main 当前生成，但不会自动取消后台 agent。
- 只有 main 的输出会进入用户对话时间线。
- TUI 保持输入可用，并能展开查看 agent 与工具活动。
- 项目中不存在 Web 服务入口、Web 静态资源或 `coder web` 命令。
- 重启后 Session、AgentInstance 和未处理 mailbox 可以恢复。
- `npm run typecheck`、`npm run build` 和全量测试通过。
