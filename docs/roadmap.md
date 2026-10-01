# 路线图

> 状态：草稿。依据 [philosophy.md](philosophy.md) 整理，取代 `hardening-backlog.md` 中仍有效的部分。
> 排序原则：先拿到数据，再改结构，最后扩能力；任何"能力扩展"都要用评测证明有效。

## 阶段 0：马上能做，风险低

| # | 事项 | 说明 | 状态 |
|---|---|---|---|
| 0.1 | **DeepSeek `reasoning_content` 回传** | 已实现：流里的 `reasoning_content` 存到 assistant 消息上，之后每次请求原样带回（仅当模型返回过该字段，不会给其他网关凭空加字段），并计入上下文预算。后端和运行时各有测试，均已确认改动前失败、改动后通过。**尚未在真实 DeepSeek 接口上验证**：回传规则按保守版本实现（凡带该字段的 assistant 消息都回传），官方文档站被网络策略拦截，未能核对精确条件。Anthropic 路径未启用 thinking 参数，不涉及。 | 已实现，待真实接口验证 |
| 0.2 | **评测基线** | 跑通现有 `tests/benchmarks` 的 HumanEval，得到第一个数字；评估扩展到仓库级评测（SWE-bench Lite 子集或 Terminal-Bench）；对失败任务做分类（找不到文件 / 编辑出错 / 验证不足 / 上下文丢失 / 其他）。 | 待做 |
| 0.3 | **仓库卫生** | 已完成：`package-lock.json` 里 99 处指向 `registry.npmmirror.com` 的下载地址改回官方源（受限网络下 `npm ci` 会无限卡住，现在默认参数 1.5 秒装完）；`@types/blessed` 移到 devDependencies；加 `engines.node >=22`（与 CI 矩阵一致）；benchmark 时间戳报告不再入库（只保留 `*-latest.*`，旧报告仍在 git 历史里）；`AgentToolCall.function.arguments` 的类型由 `Record<string, string>` 改为 `Record<string, unknown>`（与实际一致）。**未做（需要决定或留给本地）：** ① 测试纳入类型检查——目前有 90 个错误，其中 86 个在 `tests/fullscreen-tui.test.ts`（访问 blessed 内部属性 `lines` / `items` / `style`，类型包里没有），另有 `backend.test.ts`、`compact.test.ts`（含一个真 bug：`assert.ok(x.length, 1)` 的第二个参数只是失败消息，应为 `assert.equal`）、`session-timeline.test.ts` 各 1 至 2 个；② lint / format 脚本需要引入 eslint / prettier 等新依赖，待决定；③ 品牌与 bin 别名统一（`maw` / `tokenmaw` / `coder` / `coding-agent`），待决定。 | 部分完成 |
| 0.4 | **文档合并** | `hardening-backlog.md` 的过期状态已改为状态快照（见该文件顶部）；其余 4 份审计文档暂未合并，仍待做。 | 部分完成 |

## 本轮已完成的能力改进（未经评测，需要你本地用真实模型验证）

这些改动都是各大 agent 已普遍具备、且不依赖具体模型的能力。因为没有 API，**没有任何评测数据**证明它们提高了完成率，每一项都附了验证方法。单元测试均已通过（改动前失败、改动后通过）。

| 改动 | 解决的问题 | 本地怎么验证 | 回退方式 |
|---|---|---|---|
| **bash 加固**（`src/infra/shell.ts`） | 失败只说 "command failed"，没有退出码，分不清失败与超时；超时只杀 shell，`npm test` 的子进程变成孤儿；stdin 开着，交互式提示会干等满 60 秒；`server &` 会卡住整个调用；ANSI 颜色码白占 token | 让 agent 跑一个会失败的测试命令，看结果是否带 `exit code N`；跑 `sleep 100`（`timeout_ms` 设小），确认超时后 `ps` 里没有残留进程 | 还原 `tools.ts` 里 `bash` 分支为 `exec` |
| **编辑后语法诊断**（`src/infra/diagnostics.ts`） | 编辑把文件改坏，要等下一次运行才知道。现在 `write_file` / `edit_file` 成功后，对 JSON / Python / JS / TS(X) / shell 做纯语法检查，**有错才提示**，且写入从不被阻塞 | 让 agent 故意写一个语法错误的 `.ts` / `.py`，看工具结果里是否在 OK 行后出现 `⚠ Syntax check failed`；正常文件不应出现任何额外文字 | 环境变量 `AGENT_SYNTAX_CHECK=0` |
| **skill 可发现 + 分层**（`src/infra/skills.ts`） | 模型不知道有哪些 skill，只有调用失败才在报错里看到名字；skill 只在 `<workspace>/skills` 里找，与 agent spec 三层不一致 | 在 `.coder/skills/` 放一个带 `description:` 的 skill，看 `load_skill` 的工具描述是否列出它，并让 agent 在合适任务里主动加载 | 无需回退，向后兼容 |
| **`read_file` 防护**（`src/infra/text-file.ts`） | 二进制被当 UTF-8 解码成乱码；不传 `limit` 整份读入再被运行时从中间硬截断；压缩 JS 的超长单行冲掉上下文 | 让 agent 读一个 PNG、一个 3000 行文件、一个压缩过的 bundle，看输出是否分别是"二进制"提示、带续读范围的窗口、被截短的行 | 还原 `tools.ts` 里 `read_file` / `read_files` |
| **`implement` 工作标准**（`agents/implement.md`） | 原来只有 94 个词。现在写明：先理解再改、能复现就先复现、最小改动、用项目自己的命令由窄到宽验证、不为通过检查而削弱测试、把工具反馈当证据 | 对比同一批任务在新旧 `implement.md` 下的表现（这是唯一一项需要真实评测才能判断好坏的文档改动） | `git revert` 该提交 |
| **DeepSeek `reasoning_content` 回传** | 见 0.1 | 用 DeepSeek 开启 thinking，跑一次多轮工具调用，确认不再 400 | 见 0.1 |

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

## 低优先级（沿用 hardening-backlog，已按代码核对状态）

- 已完成：A1 原子写、A2 会话文件 0600 且损坏会话拒绝覆盖、A3 symlink、A5 锁、B1 SSE 错误透出、B3 的 `Retry-After`。
- A4 已完成：配置文件 0600；会话快照与压缩归档在**写盘时**脱敏（`src/infra/redact.ts`）——精确匹配所有已配置的 apiKey 和名字像密钥的环境变量值，另外识别特征明显的格式（`sk-` / `ghp_` / `AKIA` / PEM 私钥等）。内存中的对话和发给模型的内容不变（agent 有时确实要用这些值）。
- 未做：B2 共享 SSE 读取器、B3 的"POST 默认不重试"、C1 timeline O(1) 追加、C2 TUI 帧内重复计算、C3 持久化 debounce（阶段 1.1 的追加式日志会取代它）、C4 `x-opencode-session` 头仅对 opencode 发送。

## 待决定

- **完成证据由谁来守**（哲学原则 6 的方案 A / B）。
- 权限的具体类别与粒度。
- "厚文档"假设怎么验证：用哪个场景、哪组任务。
- 多 agent 编排在"能力第一"下是必须的还是按需的。
- `run:` 外部进程的沙箱什么时候做。
