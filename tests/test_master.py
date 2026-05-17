import asyncio
from pathlib import Path
from unittest.mock import patch

from coding_agent.master import MasterCoordinator


def test_accept_prompt_and_complete(tmp_path: Path):
    master = MasterCoordinator(skill_dir=tmp_path / "skills")

    async def _run():
        with patch("coding_agent.agent.DedicatedAgent._run_model_call", return_value="fixed bug successfully"):
            task_id = await master.accept_prompt("u1", "fix bug in parser")
            for _ in range(100):
                task = master.get_task(task_id)
                if task and task.result:
                    break
                await asyncio.sleep(0.01)
            task = master.get_task(task_id)
            assert task is not None
            assert task.result == "fixed bug successfully"

    asyncio.run(_run())
