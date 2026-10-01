# 路线图

> 状态：草稿。依据 [philosophy.md](philosophy.md) 整理，取代 `hardening-backlog.md` 中仍有效的部分。
> 排序原则：先拿到数据，再改结构，最后扩能力；任何"能力扩展"都要用评测证明有效。

## 阶段 0：马上能做，风险低

| # | 事项 | 说明 | 状态 |
|---|---|---|---|
| 0.1 | **DeepSeek `reasoning_content` 回传** | 已实现：流里的 `reasoning_content` 存到 assistant 消息上，之后每次请求原样带回（仅当模型返回过该字段，不会给其他网关凭空加字段），并计入上下文预算。后端和运行时各有测试，均已确认改动前失败、改动后通过。**尚未在真实 DeepSeek 接口上验证**：回传规则按保守版本实现（凡带该字段的 assistant 消息都回传），官方文档站被网络策略拦截，未能核对精确条件。Anthropic 路径未启用 thinking 参数，不涉及。 | 已实现，待真实接口验证 |
| 0.2 | **评测基线** | 跑通现有 `tests/benchmarks` 的 HumanEval，得到第一个数字；评估扩展到仓库级评测（SWE-bench Lite 子集或 Terminal-Bench）；对失败任务做分类（找不到文件 / 编辑出错 / 验证不足 / 上下文丢失 / 其他）。 | 待做 |
| 0.3 | **仓库卫生** | 已完成：`package-lock.json` 里 99 处指向 `registry.npmmirror.com` 的下载地址改回官方源（受限网络下 `npm ci` 会无限卡住，现在默认参数 1.5 秒装完）；`@types/blessed` 移到 devDependencies；加 `engines.node >=22`（与 CI 矩阵一致）；benchmark 时间戳报告不再入库（只保留 `*-latest.*`，旧报告仍在 git 历史里）；`AgentToolCall.function.arguments` 的类型由 `Record<string, string>` 改为 `Record<string, unknown>`（与实际一致）。**未做（需要决定或留给本地）：** ① 测试纳入类型检查——目前有 90 个错误，其中 86 个在 `tests/fullscreen-tui.test.ts`（访问 blessed 内部属性 `lines` / `items` / `style`，类型包里没有），另有 `backend.test.ts`、`compact.test.ts`（含一个真 bug：`assert.ok(x.length, 1)` 的第二个参数只是失败消息，应为 `assert.equal`）、`session-timeline.test.ts` 各 1 至 2 个；② lint / format 脚本需要引入 eslint / prettier 等新依赖，待决定；③ 品牌与 bin 别名统一（`maw` / `tokenmaw` / `coder` / `coding-agent`），待决定。 | 部分完成 |
| 0.4 | **文档合并** | `docs/` 有 5 份重叠的审计和计划；把仍有效的并入本文件，已完成的归档。修正 `hardening-backlog.md` 末尾"仅计划，未执行"的过期状态。 | 待做 |

## 阶段 1：数据基础（原则 7）

| # | 事项 | 说明 |
|---|---|---|
| 1.1 | **追加式会话日志** | 会话改为只追加的事件日志，增加不变量"模型可见的内容都已记录，且每个模型请求都能从日志重建"。同时解决崩溃安全、回放和对比（取代 backlog 的 C3 debounce 方案）。借鉴自 DeepSeek Harness 的 session log。 |
| 1.2 | **评测接入日常流程** | 每次改动能跑一组固定任务，结果入库可对比。没有这个，阶段 3 无法判断优先级。 |

## 阶段 2：让代码贴合哲学

| # | 事项 | 对应原则 | 说明 |
|---|---|---|---|
| 2.1 | **"读后才能改"移出核心** | 4 | `src/tools/types.ts` 的 `ToolExecutionContext` 里有 `requirePriorRead` / `getReadVersion` / `recordReadVersion` / `recordWriteVersion`，是 `read_file` 与 `edit_file` 的私有约定。改为核心提供按能力命名空间隔离的会话状态存储，由文件工具自己使用。 |
| 2.2 | **拆分 `src/infra/tools.ts`** | 3 | 1692 行的 switch，工具声明和实现分离，表驱动注册，消除名字写错落到 `{effect:'read'}` 兜底的问题。原生文件工具作为一个整体包。 |
| 2.3 | **拆分超大模块** | 2 | `src/ui/fullscreen-tui.ts`（2427 行）、`src/runtime/agent-runtime.ts`（1672 行）。 |
| 2.4 | **数据安全遗留（A2 / A4）** | 8 | 会话文件权限与损坏文件隔离；apiKey 脱敏与配置文件 `chmod 600`。 |

## 阶段 3：能力扩展（需要阶段 0.2 / 1.2 的数据支撑）

每一项都要在评测里看到效果，没有提升的不保留。

| # | 事项 | 说明 |
|---|---|---|
| 3.1 | **统一 capability 声明格式（试点）** | 先用一个现有只读工具（或 `load_skill`）按 Markdown + frontmatter 重新声明，看复杂度是降了还是升了，再决定是否推广。 |
| 3.2 | **权限模型** | 能力声明所需权限；首次使用时展示清单、用户同意才生效；授权记录存在用户级文件（按能力 + 内容哈希）；清单变化需重新同意；先粗粒度。 |
| 3.3 | **工具执行拦截点** | 工具执行前后的统一拦截（pre / post execute），权限检查和 Hooks 都作为其上的监听者。 |
| 3.4 | **MCP** | 作为 `run:` 的一种后端接入。 |
| 3.5 | **LSP 诊断** | 编辑后自动获取类型 / 语法错误反馈。 |
| 3.6 | **OS 级沙箱** | 对 `run:` 外部进程用 bwrap / Landlock / Seatbelt，使权限声明真正可强制。 |
| 3.7 | **其余**（来自 SOTA 差距分析） | Plan mode 的批准门、checkpoint 还原、跨会话记忆、reasoning effort 旋钮、成本护栏。 |

## 低优先级（沿用 hardening-backlog）

- B2 共享 SSE 读取器（`try/finally` + `reader.cancel()` + `\r\n` 规范化）
- C1 timeline O(1) 追加
- C2 TUI 帧内重复计算（`toolDiff` 缓存、`getSession()` 深拷贝）
- C4 `x-opencode-session` 头仅对 opencode 发送

## 待决定

- **完成证据由谁来守**（哲学原则 6 的方案 A / B）。
- 权限的具体类别与粒度。
- "厚文档"假设怎么验证：用哪个场景、哪组任务。
- 多 agent 编排在"能力第一"下是必须的还是按需的。
- `run:` 外部进程的沙箱什么时候做。
