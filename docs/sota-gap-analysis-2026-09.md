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

## 待修安全债（顺手做，不阻塞能力演进）
- A1 原子写 EPERM 毁文件（`tools.ts:123`、`agent-store.ts:26`）
- A3 symlink 逃逸（无 realpath）
- B1 SSE error 被 catch 吞掉（`backend.ts:650`）
- B3 重试忽略 Retry-After

## 已有优势
- 多 agent mailbox 运行时完整（spawn/send/wait/cancel、深度扇出限制）
- 上下文工程齐了（auto-compact + search_history + board + task anchor + result truncation）
- prompt caching（刚补）
- 跨进程锁/会话单写者/乐观冲突检测
- TUI sticky header、thinking 计时

## 决策
- 建议先做 MCP → hooks → LSP 三件套
- 安全债 A1/A3/B1 顺手修
