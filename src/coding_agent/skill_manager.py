from __future__ import annotations

import json
from pathlib import Path
from typing import Dict

from .models import SkillCandidate


class SkillManager:
    def __init__(self, skills_dir: Path, min_successes: int = 3, min_ratio: float = 0.8):
        self.skills_dir = skills_dir
        self.skills_dir.mkdir(parents=True, exist_ok=True)
        self.min_successes = min_successes
        self.min_ratio = min_ratio
        self._candidates: Dict[str, SkillCandidate] = {}

    def track_outcome(self, pattern: str, satisfied: bool) -> None:
        if pattern not in self._candidates:
            self._candidates[pattern] = SkillCandidate(
                name=self._sanitize_name(pattern),
                pattern=pattern,
            )
        c = self._candidates[pattern]
        c.success_count += 1
        if satisfied:
            c.satisfied_count += 1
        if c.success_count >= self.min_successes and c.satisfaction_ratio() >= self.min_ratio:
            self._materialize_skill(c)

    def _materialize_skill(self, candidate: SkillCandidate) -> None:
        skill_file = self.skills_dir / f"{candidate.name}.json"
        payload = {
            "name": candidate.name,
            "pattern": candidate.pattern,
            "source": "auto-generated",
            "success_count": candidate.success_count,
            "satisfied_count": candidate.satisfied_count,
        }
        skill_file.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    @staticmethod
    def _sanitize_name(pattern: str) -> str:
        return "".join(ch if ch.isalnum() else "_" for ch in pattern.lower()).strip("_")[:64] or "skill"
