# Coder 自用审计记录（dogfooding issues）

> 来源：在真实任务中把 Coder 当作日常 agent 使用后的切身体会。
> 背景：一个"为 TUI 加 Thinking 计时显示"的小任务中，暴露了 edit/搜索/反馈层的多个可靠性问题。
> 日期：2026-09-07 · 基于 HEAD `8929856`

## 问题清单（按优先级）

### 1. `edit_file` fuzzy match 存在静默错位风险 — 🔴 最高优先级

**现象**
在 `src/backend.ts` 中修改一个 `return { ... }` 块时，文件里存在两段几乎相同的代码
（`ollamaNonStream` 与 `anthropicNonStream` 的 return 块）。`edit_file` 的模糊匹配
把替换打到了**错误的函数**上，且报告 "fuzzy match" 成功。为修正错位反复 edit 了 4 次。

**风险**
- 静默错位 = 生产环境破坏用户代码，agent 却以为成功了。
- fuzzy 容忍度越高，多处近似代码时越危险。
- 修正错位本身又要多次 edit，进一步放大风险面。

**修复建议**
1. search 命中多个位置时**不要猜测**，返回错误并给出各候选项的行号，让 agent 换更长锚点。
2. 替换后校验：结果必须包含 `replace` 文本、且旧文本只出现预期次数。
3. 提供 `expectedReplacements`（默认 1）参数，超出即失败。
4. fuzzy 仅作为"找不到精确匹配"时的最后手段，且必须报告匹配距离与位置。

### 2. edit 工具的结果反馈不可信 — 🔴 高

**现象**
- 一次 edit 实际只改了约 5 行，返回 diff 却显示 "621 more changed lines"（虚假扩展）。
- 有一次报告成功，但实际内容未变化，需要 agent 额外 `git diff` 自查。
- 结论：工具返回值不能作为"已成功"的依据，agent 被迫花额外轮次验证。

**修复建议**
1. diff 摘要与实际文件变化一致（由写入后的真实内容重新生成，而非编辑意图）。
2. 返回中带上文件的新 sha/行数变化，方便 agent 校验。
3. "no-op edit"（search 未找到任何差异）应明确返回状态，而不是含混的成功。

### 3. Windows 下搜索能力薄弱 — 🟠 中

**现象**
- 没有 grep/ripgrep 工具；`rg`、`head`、`tail`、`Get-Content` 在内置 bash 里均不可用
  （实际执行环境是 cmd，找不到这些命令）。
- `search_text` 用正则（如 `thinkingBlocks\.set`）搜不到，同一 pattern `findstr` 能找到。
  正则路径疑似失效或被转义破坏。
- agent 只能退化为逐文件 `read_file`，多轮浪费。

**修复建议**
1. `search_text` 的正则分支加回归测试（含 `\.`、`\d` 等常见转义）。
2. 内置一个纯 JS 的 ripgrep 替代（递归 + glob + 正则），不依赖 shell。
3. bash 工具在 Windows 上明确暴露"可用 shell 能力"，避免 agent 反复试错。

### 4. usage / token 统计缺失 — 🟠 中

**现象**
用户与 agent 都看不到每次 turn 花了多少 token。四个后端（Anthropic / Ollama /
OpenAI Chat / Responses）的流式协议其实都返回 usage：

- Anthropic：`message_start` 给 `input_tokens`，`message_delta` 给 `output_tokens`
- Ollama：末行 NDJSON 的 `prompt_eval_count` / `eval_count`
- OpenAI Chat：`usage`（需 `stream_options: { include_usage: true }`）
- Responses：`response.completed` 的 `usage`（含 `reasoning_tokens`）

**修复建议**（方案已调研，可随时重启）
1. `ChatChunk` 增加 `usage?: { inputTokens; outputTokens; reasoningTokens? }`，各后端解析。
2. runtime 聚合每 turn 用量，写入 SessionMessage 与 timeline（持久化）。
3. TUI 在状态栏或 Agent Activity 显示 per-turn / per-session 消耗。

### 5. `write_file` 无防呆 — 🟡 低

**现象**
整文件覆盖写，没有备份、没有冲突检测。agent 对现有文件理解有偏差时，
一次 `write_file` 就会静默毁掉用户内容。

**修复建议**
1. 覆盖已有文件时，若旧内容超过阈值行数（如 >50 行），要求 `expectedOldLines`
   或 `createBackup: true` 之类的显式确认参数。
2. 或自动生成 `.bak` / 写入 git stash 式快照后再覆盖。
3. 至少在返回信息中报告"覆盖了已有 N 行的文件"。

## 本次审计的经验教训

- **工具结果必须可信**：edit/diff 报告失真会让 agent 的每一步都变贵。
- **歧义要 fail loudly**：宁可报错让 agent 重试，也不要模糊匹配后静默成功。
- **Windows 环境是二等公民**：搜索与 shell 兜底路径需要在 CI 里跑真实 Windows 用例。
- 验证代码（typecheck / 全量测试）比任何"成功"回执都可靠 —— 本次改动最终以
  `npm run typecheck` + `npm test` 的真实输出为准。
