# Top-tier Coding Agent（类似 Claude Code 的协同编码代理）

这个项目实现了你描述的关键差异化能力：

- **24x7 持续运行**：Master 常驻，持续接收任务。
- **每个 Prompt 立即接管**：每个请求都创建独立 `DedicatedAgent`，不需要等待队列空闲。
- **Master 统一协调**：所有任务通过 `MasterCoordinator` 汇总，便于集中管理写文件策略和冲突控制。
- **自动沉淀 skill**：重复模式且满意度高时，会自动产出可复用技能文件。


## 自动 Skill 规则（当前默认）

- 同一模式成功次数 >= 2
- 满意度 >= 80%
- 自动写入 `skills/`
