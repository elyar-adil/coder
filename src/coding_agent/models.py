from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, Optional


class TaskStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    BLOCKED = "blocked"
    COMPLETED = "completed"
    FAILED = "failed"


@dataclass(slots=True)
class PromptTask:
    task_id: str
    user_id: str
    prompt: str
    status: TaskStatus = TaskStatus.QUEUED
    result: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class SkillCandidate:
    name: str
    pattern: str
    success_count: int = 0
    satisfied_count: int = 0

    def satisfaction_ratio(self) -> float:
        if self.success_count == 0:
            return 0.0
        return self.satisfied_count / self.success_count
