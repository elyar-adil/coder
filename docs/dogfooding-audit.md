# Coder 自用审计记录（dogfooding issues）

> 来源：在真实任务中把 Coder 当作日常 agent 使用后的切身体会。
> 背景：一个"为 TUI 加 Thinking 计时显示"的小任务中，暴露了 edit/搜索/反馈层的多个可靠性问题。
> 日期：2026-09-07 · 基于 HEAD `8929856`

## 修复进度（2026-09-07）

| 问题 | 状态 | 说明 |
| --- | --- | --- |
| 1. edit_file fuzzy 错位 | ✅ 已修复 | 删除全部阈值类模糊策略，对齐 Claude Code / pi 的纯确定性匹配 |
| 2. edit 反馈失真 | ✅ 已修复 | diff 由写入后真实内容生成 + readback 验证 + 行数/sha 上报 + no-op 显式状态 |
| 3. Windows 搜索薄弱 | ✅ 已修复 | rg 任意失败退化纯 JS fallback + 正则回归测试 + win32 bash 能力声明 |
| 4. usage/token 统计 | ⏸ 暂缓 | 方案已调研定稿（见下文），暂不实施 |
| 5. write_file 无防呆 | ✅ 已修复 | 覆盖前自动快照（`.coder/snapshots/`），对齐 OpenCode/Claude Code 的快照+回滚模式 |

验证基线：`npm run typecheck` 无错误 + `npm test` 135 pass / 0 fail。

## 问题清单（按优先级）

### 1. `edit_file` fuzzy match 存在静默错位风险 — 🔴 最高优先级 ✅ 已修复

**现象**
在 `src/backend.ts` 中修改一个 `return { ... }` 块时，文件里存在两段几乎相同的代码
（`ollamaNonStream` 与 `anthropicNonStream` 的 return 块）。`edit_file` 的模糊匹配
把替换打到了**错误的函数**上，且报告 "fuzzy match" 成功。为修正错位反复 edit 了 4 次。

**风险**
- 静默错位 = 生产环境破坏用户代码，agent 却以为成功了。
- fuzzy 容忍度越高，多处近似代码时越危险。
- 修正错位本身又要多次 edit，进一步放大风险面。

**修复建议**（已实施，见文末"修复进度"）

**实施说明（2026-09-07）**：调研 Claude Code（泄漏源码）/ pi / OpenCode 后确认：SOTA 实现已淘汰相似度阈值类模糊匹配（Claude Code 纯精确匹配、零 fuzzy；OpenCode 的 BlockAnchor fuzzy 正被社区视为可靠性负债）。据此：
1. 删除 `fuzzyFind` 的策略 7/8（BlockAnchor + Levenshtein，0.7/0.3/0.5 阈值全部作废），保留 6 个确定性归一化层（精确 / read_file 行号剥离 / 行 trim / 空白归一 / 缩进弹性 / 转义归一），替换为 `findUniqueMatch`（src/infra/tools.ts:239）。
2. 每层强制唯一命中（`indexOf === lastIndexOf`）；多命中报错并列出候选行号；找不到报错并给出最接近位置提示（pi 风格）。
3. 新增 `expectedReplacements`（默认 1）与 `replaceAll`，超出即失败。
4. 写后 readback 验证（确认 replace 文本存在且次数正确）。
回归测试：tests/edit-file-sota.test.ts（11 例）+ tests/tools.test.ts。

### 2. edit 工具的结果反馈不可信 — 🔴 高 ✅ 已修复

**现象**
- 一次 edit 实际只改了约 5 行，返回 diff 却显示 "621 more changed lines"（虚假扩展）。
- 有一次报告成功，但实际内容未变化，需要 agent 额外 `git diff` 自查。
- 结论：工具返回值不能作为"已成功"的依据，agent 被迫花额外轮次验证。

**修复建议**（已实施，见文末"修复进度"）

**实施说明（2026-09-07）**：diff 由写入锁下重新读取的写前内容 vs 实际写入内容生成（不再依赖可能过期的变量）；成功返回带 `old → new` 行数与 12 位 sha256；no-op edit（search === replace 或内容无变化）显式返回 "OK: no changes made"，不写文件不出 diff。

### 3. Windows 下搜索能力薄弱 — 🟠 中 ✅ 已修复

**现象**
- 没有 grep/ripgrep 工具；`rg`、`head`、`tail`、`Get-Content` 在内置 bash 里均不可用
  （实际执行环境是 cmd，找不到这些命令）。
- `search_text` 用正则（如 `thinkingBlocks\.set`）搜不到，同一 pattern `findstr` 能找到。
  正则路径疑似失效或被转义破坏。
- agent 只能退化为逐文件 `read_file`，多轮浪费。

**修复建议**（已实施，见文末"修复进度"）

**实施说明（2026-09-07）**：rg 除"成功 + exit 1（无匹配）"外的任何失败（ENOENT、exit ≥ 2 的坏正则、spawn 错误、Windows .cmd shim 等）均退化到纯 JS `searchTextFallback`（已导出便于测试），两级错误信息合并上报；fallback 正则回归测试覆盖 `\.`、`\d`、非法正则字面量退化、glob 过滤、`m` 锚定、上限截断（tests/search-text.test.ts，6 例）；bash 工具在 win32 下于描述与结果中声明 cmd.exe 能力边界并建议改用 search_text/read_file。

### 4. usage / token 统计缺失 — 🟠 中 ⏸ 暂缓（方案已定，随时可重启）

**现象**
用户与 agent 都看不到每次 turn 花了多少 token。四个后端（Anthropic / Ollama /
OpenAI Chat / Responses）的流式协议其实都返回 usage：

- Anthropic：`message_start` 给 `input_tokens`，`message_delta` 给 `output_tokens`
- Ollama：末行 NDJSON 的 `prompt_eval_count` / `eval_count`
- OpenAI Chat：`usage`（需 `stream_options: { include_usage: true }`）
- Responses：`response.completed` 的 `usage`（含 `reasoning_tokens`）

**修复建议**（方案已调研定稿，暂缓实施）

1. `ChatChunk` 增加 `usage?: { inputTokens; outputTokens; reasoningTokens? }`，各后端解析。
2. runtime 聚合每 turn 用量，写入 SessionMessage 与 timeline（持久化）。
3. TUI 在状态栏或 Agent Activity 显示 per-turn / per-session 消耗。

（附注：实施时顺带修复 backend.ts SSE 仅按 `\n\n` 分割、不兼容 CRLF 的问题；responses.ts 已做 CRLF 归一。）

### 5. `write_file` 无防呆 — 🟡 低 ✅ 已修复

**现象**
整文件覆盖写，没有备份、没有冲突检测。agent 对现有文件理解有偏差时，
一次 `write_file` 就会静默毁掉用户内容。

**修复建议**（已实施，见文末"修复进度"）

**实施说明（2026-09-07）**：调研确认 Claude Code / OpenCode 的 Write 均不设阻断式防呆，保护手段是"写前自动快照 + 回滚"。据此放弃 `expectedOldLines` 硬阻断方案，改为：`write_file` 覆盖已有文件前自动把旧内容存入 `<workspaceRoot>/.coder/snapshots/`（`src/infra/file-snapshot.ts` 的 `snapshotBeforeWrite`，文件名含时间戳+随机后缀，绝不阻塞写入、失败优雅降级）；结果信息标注"覆盖了 N 行的文件，快照位于 X"或"快照不可用（原因）"；新建文件不产生快照。回归测试：tests/write-file-snapshot.test.ts（6 例）。

## 本次审计的经验教训

- **工具结果必须可信**：edit/diff 报告失真会让 agent 的每一步都变贵。
- **歧义要 fail loudly**：宁可报错让 agent 重试，也不要模糊匹配后静默成功。
- **Windows 环境是二等公民**：搜索与 shell 兜底路径需要在 CI 里跑真实 Windows 用例。
- 验证代码（typecheck / 全量测试）比任何"成功"回执都可靠 —— 本次改动最终以
  `npm run typecheck` + `npm test` 的真实输出为准。
