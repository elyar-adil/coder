from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI
from pydantic import BaseModel

from .master import MasterCoordinator

app = FastAPI(title="Top-Tier Coding Agent")
master = MasterCoordinator(
    skill_dir=Path("skills"),
    ollama_base_url=os.getenv("OLLAMA_BASE_URL", "http://localhost:11434"),
    model=os.getenv("AGENT_MODEL", "deepseek-v4-pro:cloud"),
)


class PromptIn(BaseModel):
    user_id: str
    prompt: str


@app.post("/prompts")
async def submit_prompt(payload: PromptIn) -> dict:
    task_id = await master.accept_prompt(user_id=payload.user_id, prompt=payload.prompt)
    return {"task_id": task_id, "status": "accepted"}


@app.get("/tasks/{task_id}")
async def get_task(task_id: str) -> dict:
    task = master.get_task(task_id)
    if not task:
        return {"error": "not_found"}
    return {
        "task_id": task.task_id,
        "status": task.status,
        "result": task.result,
        "metadata": task.metadata,
    }
