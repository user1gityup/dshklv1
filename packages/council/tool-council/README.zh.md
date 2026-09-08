# Council 工具与 API 暂存

[English](README.md) | 中文

Council、swarm、pipeline 和 proposal 协调 CLI 与 API 席位。计划批准与文件授权独立。

用户在会话权限控件选择 workspace-write 并发送完整 go 后，`stage_work` 保存已有 API 代码，不调用 CLI 或其他模型。`files_json` 将相对路径映射到完整文本，每批写入 `<会话工作区>/.dsh-staging/<批次 ID>` 并报告文件。上限为 100 个文件和 1,000,000 个输入字符。拒绝绝对路径、路径穿越和冲突的 Windows 拼写，失败时报告部分输出。

Proposal 也通过 DSH 文件沙箱写入 .dsh-staging，按运行和席位划分目录；旧 workRoot 设置不能将写入重定向到工作区外。本机 CLI 权限和参数不变，API 代理可在席位不可用时暂存工作。

## Model Experience

名单的 `council.swarmProfile` 选择 `economy` 或 `fastest`。经济模式每单元至少两个免费席位竞争并付费审查，最多一个付费后备候选和两次付费审查。最快模式每单元一个付费工作者，依赖波次并行。两者遵守工作类型，审查者需 review 能力；UI 单元优先合格的已选样例作者。无模式保留旧路由。

图包含 `acceptance`、`files`、`tier`（`ui` 或 `general`）。经济模式要求验收条件。单元不能共享目标文件。候选沿用沙箱权限门，按运行、单元和席位隔离。审查失败阻断依赖项；模型审查不运行测试或应用文件。

批准保留模式。预设可保存 `mode: council | economy | fastest`，不授权执行。执行模式的流水线规划与审查使用付费席位。估算包含读取、选择、审查及有限后备，并标示无价格调用。

计划投票不变。至少两个不同席位支持的引用可由原赢家整合；失败保留原计划。

工具模式说明暂存和批准要求。结果标明待实施的候选文件，不修改其他仓库。暂存不额外调用模型，生成内容仍正常计费；新模式在重新加载后改变请求前缀。

## Known Limitations and Deferred Work

暂存不执行、提交、排队推送或重试不可用席位。新会话需要重新批准和 go。本更改不限制本机 CLI，也不加强 Windows 进程隔离。
