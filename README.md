# Top-tier Coding Agent（类似 Claude Code 的协同编码代理）

这个项目实现了你描述的关键差异化能力：

- **24x7 持续运行**：Master 常驻，持续接收任务。
- **每个 Prompt 立即接管**：每个请求都创建独立 `DedicatedAgent`，不需要等待队列空闲。
- **Master 统一协调**：所有任务通过 `MasterCoordinator` 汇总，便于集中管理写文件策略和冲突控制。
- **自动沉淀 skill**：重复模式且满意度高时，会自动产出可复用技能文件。
- **Ollama + deepseek-v4-pro:cloud**：通过 `requests` 直接调用 HTTP 接口，不使用 Ollama Python SDK。

## 架构

- `src/coding_agent/service.py`：FastAPI 服务入口。
- `src/coding_agent/master.py`：总控协调器。
- `src/coding_agent/agent.py`：每个 Prompt 的专用 agent，调用 `POST /api/chat`。
- `src/coding_agent/skill_manager.py`：自动技能抽取与落盘。
- `src/coding_agent/models.py`：任务与技能数据结构。

## 快速启动

```bash
pip install -e .[dev]
uvicorn coding_agent.service:app --reload
```

### 环境变量

- `OLLAMA_BASE_URL`（默认 `http://localhost:11434`）
- `AGENT_MODEL`（默认 `deepseek-v4-pro:cloud`）

### API

- `POST /prompts` 提交 prompt
- `GET /tasks/{task_id}` 查询任务状态与结果

## 自动 Skill 规则（当前默认）

- 同一模式成功次数 >= 3
- 满意度 >= 80%
- 自动写入 `skills/<name>.json`
