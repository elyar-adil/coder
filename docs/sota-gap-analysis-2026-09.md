# SOTA Gap Analysis — 2026-09-10

## 结论
架构骨架不落后（多 agent、压缩、缓存、board），差距集中在能力层而非安全层。

## 能力差距（按优先级）

### P1 — 代际差距
1. **MCP** — 外部系统接入的事实标准；Claude Code/Codex/Cursor/Muse Code 全有，maw 只有 load_skill + bash
2. **Hooks** — edit 后自动跑 linter/formatter、bash 前 denylist 检查、session 结束写日志
3. **LSP 诊断** — edit 后自动拿类型/语法错误反馈，对 TS/Python 项目是巨大加速器

### P2 — 工作流原语
4. **Plan mode / 只读研究** — 复杂任务先出计划再执行；board 是载体，缺"批准后执行" gate
5. **Checkpoint restore** — 快照已存在，只差还原命令（Claude Code Esc-Esc 回退）
6. **跨会话记忆** — board 是 per-session，无自动 memory

### P3 — 进阶
7. **Reasoning effort 旋钮** — Codex minimal→xhigh，maw per-agent model 有，effort 不可调
8. **Per-subagent worktree** — Muse Code 每个 subagent 独立 git worktree
9. **SWE-bench Lite eval** — harness 已有，repo 级 benchmark 还是 placeholder
10. **成本护栏** — usage 有了，无 budget 预警/上限

## 待修安全债（2026-09-26 更新：四项已全部修完）
- ✅ A1 原子写（`src/infra/tools.ts` stagedWrite + atomicWrite）
- ✅ A3 symlink 逃逸（`src/infra/tools.ts` executeBuiltinTool 出口处 realpath 包含检查，policy level off 时跳过）
- ✅ B1 SSE error 被吞（provider error 事件现在使流失败）
- ✅ B3 重试尊重 Retry-After（`src/fetch.ts` 解析头部并封顶 60s，FetchError 携带 retryAfterMs，agent-runtime 流重试取两者较大值）

## 已有优势
- 多 agent mailbox 运行时完整（spawn/send/wait/cancel、深度扇出限制）
- 上下文工程齐了（auto-compact + search_history + board + task anchor + result truncation）
- prompt caching（刚补）
- 跨进程锁/会话单写者/乐观冲突检测
- TUI sticky header、thinking 计时

## 决策
- 建议先做 MCP → hooks → LSP 三件套
- 安全债 A1/A3/B1 顺手修
