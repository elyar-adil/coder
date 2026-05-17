from __future__ import annotations

from dataclasses import dataclass

from .models import PromptTask, TaskStatus


@dataclass(slots=True)
class WorkerReport:
    task_id: str
    outcome: str
    success: bool


class DedicatedAgent:
    """每个用户 prompt 都由一个专用 agent 处理，避免排队等待。"""

    def __init__(self, task: PromptTask, ollama_base_url: str, model: str, timeout_seconds: float = 120.0):
        self.task = task
        self.ollama_base_url = ollama_base_url.rstrip("/")
        self.model = model
        self.timeout_seconds = timeout_seconds

    async def run(self) -> WorkerReport:
        self.task.status = TaskStatus.RUNNING
        try:
            outcome = self._run_model_call(self.task.prompt)
            self.task.status = TaskStatus.COMPLETED
            self.task.result = outcome
            return WorkerReport(task_id=self.task.task_id, outcome=outcome, success=True)
        except Exception as exc:  # noqa: BLE001
            self.task.status = TaskStatus.FAILED
            self.task.result = f"Agent failed: {exc}"
            return WorkerReport(task_id=self.task.task_id, outcome=self.task.result, success=False)

    def _run_model_call(self, prompt: str) -> str:
        payload = {
            "model": self.model,
            "stream": False,
            "messages": [
                {
                    "role": "system",
                    "content": "You are a senior coding agent. Complete the user's coding request safely and accurately.",
                },
                {"role": "user", "content": prompt},
            ],
        }
        import requests

        response = requests.post(
            f"{self.ollama_base_url}/api/chat",
            json=payload,
            timeout=self.timeout_seconds,
        )
        response.raise_for_status()
        data = response.json()
        message = data.get("message", {})
        content = message.get("content", "")
        if not content:
            raise ValueError("Ollama response did not include message.content")
        return content
