# Benchmark Report: HumanEval (gemma4:31b-cloud)

Generated: 2026-08-09T15:47:52.608Z
Backend: `ollama` · Sample size: 10 · Timeout: 120.0s

## Summary
| Metric | Value |
|---|---|
| pass@1 | **0/3 (0.0%)** |
| Produced runnable code | 2/3 (66.7%) |
| Avg tool calls | 28.3 |
| Avg duration (all) | 58.7s |
| Avg duration (passing) | 0ms |

## Per-task
| Task | Pass | Verdict | Steps | Duration | Agent | Note |
|---|---|---|---|---|---|---|
| HumanEval/0 | ✗ | fail_assert | 5 | 14.3s | completed | Command failed: python __test__.py Traceback (most recent call last): File "C:\Users\Elyar\Desktop\coder\.agent-workspac… |
| HumanEval/1 | ✗ | fail_load | 40 | 92.1s | completed | Command failed: python __test__.py Traceback (most recent call last): File "C:\Users\Elyar\Desktop\coder\.agent-workspac… |
| HumanEval/2 | ✗ | fail_assert | 40 | 69.7s | completed | Command failed: python __test__.py Traceback (most recent call last): File "C:\Users\Elyar\Desktop\coder\.agent-workspac… |

## Head-to-head (placeholder)
| Agent | pass@1 |
|---|---|
| ours (gemma4:31b-cloud) | 0.0% |
| Claude Code | not measured yet |
| Codex | not measured yet |

_Claude Code / Codex rows are placeholders — fill in once their runs are measured on the same task slice._