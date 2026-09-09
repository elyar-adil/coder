# 加固与收尾待办计划（未执行）

> 2026-09-07 整理。来源：session-1788752903967 中 5 个只读探索代理的审查报告 + 本轮改动的自查。
> 状态：**仅计划，未执行**。已按产品决策撤掉 S1/S3（策略收紧）——用户运行 yolo 模式，不接受任何交互摩擦。
> 本文档中所有 file:line 基于 commit `089d5c4`，执行时行号可能漂移，以描述为准。

## 背景与已完成的基线

本轮已完成（commit 86f1569..089d5c4）：

- opencode-go 会话头修复（x-opencode-session + UA + 错误体透出）
- 上下文压缩三件套（compact_context / search_history 工具、自动 compact、/compact、归档）
- TUI 渲染性能（合帧 + markdown LRU 缓存 + 增量行锚点）
- GFM 表格渲染 + diff 深色底配色
- 文档与 .gitignore

以下为剩余待办。

---

## 批次 A — 数据安全（零 UX 变化，纯 bug 修复）

| 项 | 位置 | 现状问题 | 修复方向 |
|---|---|---|---|
| A1 统一原子写 | 新 `src/infra/atomic-write.ts`；现 `src/infra/tools.ts`（atomicWrite，EPERM 分支 `rm(path,{force:true})` 后 rename）、`src/runtime/agent-store.ts`（replaceFile，同样先删目标）、`src/config.ts`（第三套实现） | 三套实现行为漂移；Windows EPERM 重试路径**先删好文件再重试**，6 次失败 = 目标文件被销毁（会话历史/被编辑文件丢失） | 合并为单一实现：重试 + 退避 + **永不 `rm(target)`**（EPERM/EEXIST 时改 copyFile 兜底）+ finally 清 temp |
| A2 会话文件防护 | `src/runtime/agent-store.ts` | 会话/归档文件 0644；load 解析失败静默返回 undefined → 同 id 新建会话直接覆盖历史 | `mode: 0o600`；损坏文件改名隔离为 `<id>.corrupt.<ts>` 并发出告警事件，不再静默重建 |
| A3 symlink 逃逸 | `src/policy.ts`（纯词法路径判断）、`src/infra/tools.ts`（read/write 授权）、`file-snapshot.ts`（snapshot 读跟随链接） | 工作区内符号链接指向 `/etc/shadow` 可被 read_file 读取；对符号链接 write_file 会把机密读进 `.coder/snapshots` 并随 `git add` 泄露 | 授权前对文件及各级祖先 `realpath`；snapshot 读取 `lstat` 拒绝符号链接 / `O_NOFOLLOW`；`writeViaWorkspace` 字符串前缀判包含改 `path.relative`（`/repo` vs `/repo2` bug） |
| A4 密钥防护 | `src/runtime/agent-runtime.ts`（persistSession）、`src/config.ts`（配置写盘） | `.agentrc` 的 apiKey 明文可经工具结果进入消息/时间线，全量明文写入 `~/.coder/runtime/<id>.json`（0644），无任何脱敏 | 持久化层对已知 apiKey 值做替换脱敏（读配置时收集已知密钥集合）；配置文件写入时 `chmod 600` |
| ~~A5 锁正确性~~ | `src/runtime/locks.ts` | ✅ 已修复（2026-09-09）：release 改为 ownership token 幂等化；跨进程层新增 `src/runtime/file-lock.ts`（O_EXCL 锁文件 + pid 存活检测 + 死进程接管）；带运行时上下文的写工具缺锁时**拒绝写入**（不再静默无锁）；`tests/locks.test.ts` 覆盖并发互斥、跨进程冲突、死锁接管、二次 release |

## 批次 B — 网络/流层健壮性

| 项 | 位置 | 现状问题 | 修复方向 |
|---|---|---|---|
| B1 SSE 错误透出 | `src/backend.ts`（openai/anthropic 流循环）、`src/responses.ts` | Anthropic 流中 `error` 事件抛出后被外层 `catch {}`（"skip malformed frames"）吞掉；OpenAI 同样；三家行为漂移。回合无声结束，用户只看到空回复 | 真实错误（SSE error 事件、tool_call 不完整、流提前结束）在 per-frame try 之外抛出；三家循环语义对齐 |
| B2 共享 SSE 读取器 | `src/backend.ts:104/280/532`、`src/responses.ts:70-73` | 三套循环无 try/finally、无 `reader.cancel()`——消费方提前 return 时 socket 挂到服务器关闭；只有 responses.ts 规范化 `\r\n`、检查"流提前结束" | 抽共享 `readSse(reader)`：try/finally + cancel + `\r\n` 规范化 + EOF 检测，以 responses.ts 现有实现为基准回移 |
| B3 fetch 重试策略 | `src/fetch.ts` | 非幂等 POST 对 429/5xx 也盲重试 2 次（双倍计费风险）；忽略 `Retry-After`；退避无抖动；每 attempt 给 caller signal 加 listener 从不移除 | POST 默认 `retries: 0`（幂等端点显式 opt-in）；解析 Retry-After；退避加抖动；AbortSignal 清理 |

## 批次 C — 本轮改动的收尾

| 项 | 位置 | 现状问题 | 修复方向 |
|---|---|---|---|
| C1 timeline O(1) 追加 | `src/runtime/session-timeline.ts:25,28` | 每个 delta 事件都 `entries.filter()` 全量扫描（与 TUI 同线程） | per-`(instanceId,kind)` 尾部条目索引，O(1) 追加 |
| C2 帧内残余重复工作 | `src/ui/fullscreen-tui.ts` | `toolDiff()` 每帧对每个工具条目重跑正则提取（渲染结果虽已缓存，提取没有）；`renderConversation` 每帧 `runtime.getSession()` 深拷贝全部消息 | toolDiff 结果随条目缓存；仅在相关事件时刷新 session 引用 |
| C3 持久化 debounce | `src/runtime/agent-runtime.ts`（每回合全量 stringify 落盘） | 会话越长每回合落盘越慢 | ~300ms debounce（合并连续落盘），shutdown 时强制 flush |
| C4 会话头作用域 | `src/backend.ts`（transportHeaders） | `x-opencode-session` 目前发给所有 provider，其他网关对未知头的兼容性未验证 | 仅 baseUrl 含 `opencode.ai` 时发送 |

## 批次 D — 可选清理（低优先）

- `git rm` `generate_ppt.py`、`solution.py`（零引用遗留）
- `@types/blessed` 从 dependencies 移到 devDependencies；补 `lint`/`format`/`coverage` 脚本与 `engines`
- `tsconfig.json` include 加 `tests/**`（当前测试文件不被 typecheck 覆盖）
- P2 遗留：`infra/tools.ts` 1325 行 god-module 拆分 + 表驱动工具注册（当前 typo 会静默落 `{effect:'read'}` 兜底）；search 回退对称化（rg/本地回退行为分叉、二进制跳过、truncated 误报）；R4（runTurn finally 跨回合污染）、B5（CLI 陈旧回复）；测试缺口（diff.ts、web_search、cli.ts、backend 边界用例）
- 推送 main（已领先 origin 多个提交）

---

## 明确不做（产品决策）

- **S1**：默认 moderate 策略下 bash 无限制——不加确认/allowlist，用户用 yolo
- **S3**：strict allowlist 前缀绕过——同上，不值得碰

## 执行约定

- 按 A → B → C 顺序，每批独立 commit；每批完成后跑 `npm run typecheck && npm test && npm run build`
- D 批按需另议
- 状态：**待执行**（本文档仅记录，未动代码）
