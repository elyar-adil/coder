# SOTA Coding Agent 审查报告

> 历史文档：本文审计的是 0.2.x 的旧 Task/Coordinator/Web 架构。0.3.0 已按 `architecture-revision.md` 替换该架构，本文仅保留为迁移背景，不代表当前实现状态。

> 2026-08-29 实施更新：本文主体保留的是改造前审计快照。当前代码已经完成即时任务接收、独立任务、pause/resume/cancel/steer、attempt/abort 竞态保护、稳定 event ID 与 SSE 重放、有限 live output 持久化、canonical artifact/patch 路径、写后 hash 校验、策略化验证命令、结构化完成证据、角色模型、串行原子持久化、用户级 provider/model 配置、多会话 Web、全屏任务面板 TUI 和显式 shutdown/flush。当前全量测试为 159/159，通过 typecheck 与 build。
>
> 尚未解决的长期项主要是：Reception 与 Brain 仍不是完全并行的两条流式 agent 链；Web 仍为单文件原生前端而非组件化框架；工具策略不是 OS 级沙箱；任务/会话仍按单机单用户设计；subagent 状态尚未独立持久化。这些不再属于本文所列“说完成但没做/不能恢复”的阻断级问题，但仍是商业化前需要继续推进的架构工作。

日期：2026-08-14  
范围：任务接收、路由、执行循环、工具调用、文件写入、验证、TUI/Web 反馈、session 持久化。

## 结论

当前项目已经具备 planner、tool loop、patch writer、subagent、TUI/Web 和多后端的基础骨架，但距离成熟 coding agent 的主要差距不在模型能力，而在运行时没有形成可靠的“请求 → 行动 → 证据 → 回复”闭环。

典型失败表现是：用户看到任务正在运行，模型实际没有修改目标文件或验证结果，系统却仍然输出完成/手工操作建议；网络失败、追问、重试和 session 回放也会把任务状态打散。

## P0：阻断级问题

### 1. 首次反馈被路由模型阻塞

- `src/runtime/coordinator.ts:720-750` 的 `acceptPrompt()` 先等待 `routePrompt()`，之后才创建任务并发出 `task_created`。
- 网络慢或模型不可用时，用户只看到输入，任务没有可见状态。
- 目标行为：接收入口立即创建并持久化 queued task，立即返回 task ID 和 ack；路由/规划在后台执行。

### 2. 完成判定是假阳性

- `src/runtime/coordinator.ts:1622-1631` 只要 autonomous loop 返回文本，就将任务标记为 `completed`。
- 没有要求成功的写操作、`applied/verified` patch、存在性检查、测试输出或其他可验证证据。
- 模型输出“请手工创建文件”也可能被当成完成结果。
- 目标行为：完成状态必须由证据门禁决定；没有证据应为 failed、blocked 或 needs-review。

### 3. `submit_patch` 的授权路径和实际写入路径不一致

- 工具层使用 task/workspace/artifact 上下文授权。
- `src/runtime/coordinator.ts:1046-1081` 实际使用 `resolve(process.cwd(), file.path)` 读取和写入。
- 用户指定 Desktop/Downloads 或非当前 cwd workspace 时，授权位置和写入位置可能不同，直接导致“说改了但目标文件没变”。
- 目标行为：所有读、写、patch、diff、验证统一使用一个 canonical path resolver。

### 4. Patch 验证绕过工具安全策略

- `src/runtime/coordinator.ts:1089-1096` 直接通过 `execAsync()` 执行 `verificationCommands`。
- 该路径绕过 bash denylist/allowlist、cwd 授权和统一执行记录。
- 目标行为：验证命令必须进入受策略约束的工具执行器，并记录 stdout、stderr、退出码、耗时和 cwd。

### 5. 子 agent 权限没有继承父任务

- `runSubagent` 只继承基础 policy 和 artifactDir，没有完整继承父任务的 allowed read/write roots。
- 主任务可以访问用户明确提供的外部路径时，subagent 仍可能被拒绝。
- 目标行为：子 agent 继承父任务的最小权限快照，且权限变更可审计。

### 6. 明文 API key 泄露

- `.agentrc` 当前包含明文凭据。报告不复制具体值。
- 必须立即撤销/轮换该 key，从 git 历史清除，加入 `.gitignore`，改用环境变量或本机未跟踪配置。

## P1：严重可靠性和体验问题

### 1. 所有追问都被无条件塞进 mailbox

- `src/runtime/coordinator.ts:721-725` 对 active task 的任何输入都调用 `appendTaskMailboxUpdate()`。
- “怎么样了”“重试”“找到问题了吗”无法稳定进入查询/恢复路径；任务完成后追加的 mailbox 也可能无人吸收。
- 不应继续堆关键词正则；应由接待 agent 基于结构化状态自主判断是 query、steer、retry、augment 还是 new task。

### 2. 纠偏后任务可能永久 queued

- `steerTask()` abort 后将任务置为 `queued`，但没有保证重新 enqueue。
- 目标行为：纠偏必须产生新的 attempt，并关联旧 attempt 的取消原因。

### 3. 取消存在竞态

- `cancelTask()` 立即写入 failed，但模型/网络请求没有完整接收 task abort signal。
- 旧请求完成后可能再次写入 completed 或发出 done 事件，覆盖取消结果。
- 目标行为：所有 backend stream、tool call、writer、verification 都必须共享同一个 abort signal，并在提交状态前检查 attempt token。

### 4. 网络失败缺少任务级恢复

- `src/fetch.ts` 只在单次 HTTP 请求内重试。
- 最终失败后 coordinator 直接结束任务，用户看到的是底层 `FetchError`，没有清晰的连接状态、重试次数、恢复选项或可继续的 attempt。
- 目标行为：区分 retriable/terminal failure；保留任务上下文，支持 retry/resume，而不是创建重复任务。

### 5. 消息通道重复且职责不清

- 同一结果可能经过 `master_response`、`user_visible_message`、`task_done.result` 三条通道。
- `src/ui/tui.ts:718-790` 会分别处理这些事件，可能重复显示或暴露 worker 原文。
- 目标行为：统一 `assistant_message` 事件；`task_done` 只表达生命周期结束，不能承载用户展示文本。

### 6. TUI 丢弃真实工作进展

- `src/ui/tui.ts:750-765` 直接忽略普通 `task_output` 和大多数 `tool_result`。
- 用户只能看到阶段名和工具名，看不到读取结果、测试输出、错误原因和下一步。
- 目标行为：显示当前活动、最近工具结果、错误摘要、验证状态和可折叠详细输出。

### 7. 进度条是静态阶段假象

- 每个 phase event 都追加一行，阶段顺序依赖对象 key，缺少稳定进度模型。
- 没有 attempt、当前工具、重试次数、验证证据或 ETA。
- 目标行为：每个任务维护单一可更新的 progress view，而不是不断刷屏。

### 8. session 回放和 Web 重连不完整

- TUI history 保存 raw task result，不保证保存最终用户可见回复。
- `/load` 没有完整恢复 visible messages。
- Web 刷新可能丢失时间顺序、重复 assistant 消息；SSE 断线期间的工具/阶段事件无法补发。
- 目标行为：事件带稳定 message/event ID；state snapshot 包含带时间戳的 history、task messages、当前 attempt；重连时 merge/dedupe，而不是只 hydrate 不存在的任务。

### 9. 持久化有并发覆盖风险

- 多处 `void this.persist(task)` 并发调用。
- `TaskStore.save()` 直接覆盖 JSON，没有 per-task 串行队列、版本号或原子 rename。
- 目标行为：每个 task 使用顺序写队列和 revision，落盘采用临时文件 + 原子替换。

### 10. 工具描述和实际能力不一致

- prompt 要求 worker 使用 `write_file`/`edit_file`，但 build flow 的工具集合主要开放 `submit_patch`。
- artifact 任务的读路径走 workspace，写路径走 artifact；`./file` 和 `file` 行为也不一致。
- Windows 上名为 `bash` 的工具实际使用 `cmd`，模型发出的 `ls/cat/printf` 会连续失败。
- 目标行为：工具 schema、提示、实际 executor 和平台环境必须一致，并向模型暴露真实 shell/runtime 信息。

### 11. 写入工具缺少强制证据

- prompt 要求“先读再写”，代码并未强制读取。
- patch 没有强制 base hash/before 内容时，可能无保护覆盖。
- fuzzy edit 在极低相似度时仍可能接受唯一候选，存在误替换风险。
- 写入后没有统一 read-back/hash 检查，镜像写入也可能留下不一致状态。

## P2：结构和维护性问题

- `streamPrompt` 与 `runTask` 存在两套生命周期和事件转发管线，失败/完成语义不一致。
- `generateTaskName` 每个任务额外消耗一次模型请求，可能延迟真正执行；应改为本地标题或低优先级后台任务。
- planner fallback 对中文意图识别不足，检查/分析类请求可能被错误规划为写任务。
- 当前全量测试存在跨测试持久化污染，说明测试隔离和临时 store 注入能力不足。

## 当前验证结果

- `npm run typecheck`：通过。
- `npm run build`：通过。
- 全量测试：151 项中 138 项通过、13 项失败。
- 失败集中在 coordinator 异步时序/持久化污染、prompt 契约、Web 静态资源和下载路径安全边界。

## 与成熟 SOTA Coding Agent 的能力差距

成熟 coding agent 的核心体验通常包括：

1. 请求立即进入可观察任务状态。
2. 接待、规划、执行、工具、验证、汇报职责分离，但共享统一事件流。
3. 每个动作都有输入、输出、耗时、错误和重试记录。
4. 编辑前读取，编辑后验证；完成必须有机器可检查的证据。
5. 失败可恢复，取消和纠偏不会被旧请求覆盖。
6. 任务可以暂停、继续、重连、回放，消息不会重复或丢失。
7. 子 agent 有明确父子关系、权限继承和结果收集机制。
8. 模型看到的路径、shell、工具能力与实际执行环境一致。
9. 用户可以实时介入，系统由 agent 自主决定是回答、追加要求、纠偏、重试还是新建任务。

## 建议实施顺序

### Phase 1：先恢复可信度

1. `acceptPrompt` 立即创建/持久化 task，后台路由。
2. 统一 assistant message 事件，移除 raw `task_done.result` 展示。
3. 统一 canonical path resolver，修复 submit_patch/artifact/外部路径。
4. 完成证据门禁：没有 verified patch、成功测试或明确只读证据，不得 completed。
5. 修复 abort、retry、steer 的 attempt 生命周期。

### Phase 2：补齐可恢复运行时

1. task-level retry/resume 和结构化错误。
2. per-task persistence queue + revision + atomic write。
3. 子 agent 权限继承、超时、取消和结果聚合。
4. 验证命令纳入 policy-controlled tool executor。
5. 统一 `streamPrompt`/`runTask` 管线。

### Phase 3：重做交互体验

1. TUI 显示单一可更新任务卡：阶段、活动工具、最近输出、验证结果。
2. Web/SSE 支持 snapshot replay、event ID、merge/dedupe 和断线恢复。
3. session 保存用户可见消息、工具摘要和任务状态，而不是只保存 raw result。
4. 统一终端字符集和 fallback，避免不同终端出现乱码。
5. 再优化颜色、动效和信息密度。

## 安全行动项

- 立即撤销/轮换 `.agentrc` 中的 API key。
- 将 `.agentrc` 加入忽略规则，提供 `.agentrc.example`，文档改为环境变量配置。
- 检查 git 历史、CI 日志和共享产物是否曾暴露该凭据。
