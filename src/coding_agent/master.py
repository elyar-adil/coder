from __future__ import annotations

import asyncio
import uuid
from pathlib import Path
from typing import Dict

from .agent import DedicatedAgent, WorkerReport
from .models import PromptTask
from .skill_manager import SkillManager


class MasterCoordinator:
    """总控 master：接收 prompt，创建专属 agent，并协调文件写入/任务状态。"""

    def __init__(
        self,
        skill_dir: Path,
        ollama_base_url: str = "http://localhost:11434",
        model: str = "deepseek-v4-pro:cloud",
    ):
        self.tasks: Dict[str, PromptTask] = {}
        self.skill_manager = SkillManager(skill_dir)
        self.ollama_base_url = ollama_base_url
        self.model = model
        self._lock = asyncio.Lock()

    async def accept_prompt(self, user_id: str, prompt: str) -> str:
        task_id = str(uuid.uuid4())
        task = PromptTask(task_id=task_id, user_id=user_id, prompt=prompt)
        self.tasks[task_id] = task
        asyncio.create_task(self._run_task(task))
        return task_id

    async def _run_task(self, task: PromptTask) -> None:
        agent = DedicatedAgent(
            task=task,
            ollama_base_url=self.ollama_base_url,
            model=self.model,
        )
        report = await agent.run()
        await self._post_process(task, report)

    async def _post_process(self, task: PromptTask, report: WorkerReport) -> None:
        pattern = self._infer_pattern(task.prompt)
        satisfied = report.success
        async with self._lock:
            self.skill_manager.track_outcome(pattern=pattern, satisfied=satisfied)

    def get_task(self, task_id: str) -> PromptTask | None:
        return self.tasks.get(task_id)

    @staticmethod
    def _infer_pattern(prompt: str) -> str:
        text = prompt.strip().lower()
        if "refactor" in text:
            return "refactor"
        if "test" in text:
            return "test"
        if "fix" in text or "bug" in text:
            return "bugfix"
        return "general"
