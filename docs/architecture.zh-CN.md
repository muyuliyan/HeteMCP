# HeteMCP 架构设计

> 本文是供中文阅读的配套版本。实现时以英文版 [architecture.md](architecture.md) 为准。

## 1. 目标与范围

HeteMCP 是一个供应商无关的异构模型编排服务。头部模型负责规划、路由、验收和升级；低成本模型执行边界明确的任务；Codex 或其他 MCP 客户端作为操作入口。

目标链路为：

`MCP 客户端 -> 编排器 -> 策略路由 -> 模型/Worker -> 产物 -> 验收器 -> 结果`

MVP 优先保证任务可恢复、状态明确、权限可强制、结果可验证。现阶段不构建自治代理组织、通用工作流 DSL，也不在缺少性能数据时提前引入分布式基础设施。

## 2. 架构不变量

- **确定性控制面：** 模型提出行动，程序强制执行状态迁移、租约、预算、权限、重试和验收。
- **供应商隔离：** 领域层和编排层只依赖内部接口，供应商 SDK 细节留在 adapter。
- **以产物证明完成：** 模型回复不等于成功，必须具备验收证据和持久化产物。
- **执行可恢复：** 每次 attempt 都有独立身份和有限租约；旧 attempt 不得覆盖新 owner 的结果。
- **上下文不等于授权：** 摘要和交接信息保存决策与证据，但不能扩大工具或文件权限。
- **先做模块化单体：** 在吞吐或可靠性数据证明需要前，组件边界使用进程内接口。
- **失败必须显式：** 不允许无限重试、静默降级或把部分完成报告为成功。

## 3. 组件边界

| 组件 | 负责 | 不应负责 |
|---|---|---|
| MCP Gateway | 工具 Schema 和传输层 | 路由或任务状态决策 |
| Orchestrator | 状态机、超时、取消、验收、租约所有权 | 供应商 SDK 细节 |
| Worker Loop | 任务恢复和队列消费 | 领域策略 |
| Policy Router | 根据能力、成本、延迟和风险选择候选模型 | 绕过权限 |
| Provider Adapter | 模型调用、流式响应、用量和错误映射 | 保存任务状态 |
| Worker Runtime | 隔离工具、仓库修改和产物生成 | 不受限地访问宿主机 |
| Evaluator | 测试、规则检查、确定性验收和可选模型审查 | 用主观评价替代硬证据 |
| Task Repository | 原子 claim、revision 检查和 lease 持久化 | 业务状态决策 |
| Artifact Store | patch、日志、报告、哈希和保留策略 | 把大对象塞入任务行 |
| Event/Telemetry | 可追踪事件、指标和成本 | 保存密钥或无限制的提示内容 |

依赖方向为 `transport -> application -> domain`；模型、数据库和 Worker 的实现位于 infrastructure。

## 4. 核心协议

所有跨边界数据都带版本，并在入口验证。ID 不可预测；时间统一为 UTC ISO 8601；Token 使用整数；金额使用整数微单位。

### 任务生命周期

`queued -> running -> reviewing -> succeeded | failed`

另有 `blocked`、`cancelled`，以及 lease 过期后的 `running -> queued`。业务状态只能由 Orchestrator 决定，Repository 只负责原子持久化操作。

### TaskSpecV1

包含单一可验证目标、允许与禁止路径、验收条件、Worker Profile、Token/成本限制、超时和 `ContextEnvelopeV1`。

### AttemptResultV1

包含状态、摘要、产物引用、具名检查结果、用量和可选类型化错误。成功结果必须至少包含一个产物，并为每项验收条件提供通过的检查。

### ContextEnvelopeV1

只保留当前摘要、带理由的决策、可追踪证据和未解决问题。大型原始输出应存入 Artifact Store，摘要中只保存引用。

## 5. 已完成基线

当前仓库已经具备：

- 基于 strict TypeScript 和 Zod 的任务、上下文、产物、检查、用量和结果协议；
- 确定性状态迁移、幂等创建、超时、取消和验收约束；
- 供应商无关的 `ModelProvider` 接口和确定性 fake provider；
- `create_task`、`get_task`、`cancel_task`、`get_task_result` 四个 MCP stdio 工具；
- 内存与 PostgreSQL Repository，以及乐观 revision 检查；
- 基于 `FOR UPDATE SKIP LOCKED` 的原子队列领取；
- attempt ID、worker ID、heartbeat、lease 过期回收和旧结果拒绝；
- 启动时恢复过期任务并持续消费队列的 Worker Loop；
- 幂等 PostgreSQL migration；
- 内存和 PostgreSQL 共用的 Repository 契约测试；
- MCP 传输、状态机、超时、取消、恢复和并发测试。

当前验证基线：20 个测试、严格类型检查、ESLint、Prettier、生产构建，以及生产依赖零已知漏洞。

## 6. PostgreSQL 开发决策

PostgreSQL 继续作为持久化存储，部署方式不进入领域边界。

- **本地开发和真实集成测试：** 使用 Docker Compose 运行标准 PostgreSQL。
- **快速 Repository 契约测试：** 保留 PGlite，提供确定性、无容器的快速反馈。
- **CI：** 每次改动运行快速测试，同时使用 Docker PostgreSQL 验证真实多连接行为。
- **生产环境：** 通过 `HETEMCP_DATABASE_URL` 连接任意受支持的 PostgreSQL，不假设生产使用 Docker。

Docker 集成测试需要验证并发 claim、连接中断、进程重启、长时间 heartbeat、migration 并发和索引性能。PGlite 通过只能作为有效证据之一，不能替代真实 PostgreSQL 测试。

## 7. 尚未实现

| 能力 | 缺少的工作 |
|---|---|
| 真实模型 Provider | OpenAI-compatible adapter、DeepSeek/GLM 配置、流式响应、用量解析、统一错误 |
| 隔离 Worker | Git worktree/container 生命周期、路径和命令白名单、资源限制、清理 |
| Artifact Store | 持久化 patch、commit、日志、测试报告、内容哈希、保留和权限 |
| Evaluator | 安全执行测试/lint/typecheck、patch 范围检查、可选模型审查 |
| Policy Router | 能力/成本/延迟/风险路由、故障切换和升级规则 |
| 上下文压缩器 | Token 测量、自动交接、来源引用和完整性验证 |
| 重试与预算策略 | 错误分类、有限退避、attempt/截止时间限制、Token 和费用强制上限 |
| 任务图 | 父子任务、依赖、并行分支、汇总和头部模型拆解 |
| 可观测性 | 生命周期事件、OpenTelemetry、指标、成本、进度流和 Dashboard |
| 安全 | Secret Provider、身份认证、审批门、脱敏、租户边界和保留策略 |

当前 fake provider 不会调用真实模型，也不会修改代码。未设置 `HETEMCP_DATABASE_URL` 时，任务只保存在当前进程内存中。

## 8. 实施顺序

1. 增加 Docker Compose PostgreSQL 和真实数据库集成测试。
2. 实现隔离 Worker 与 Artifact Store，让 fake provider 能产出真实 patch 和测试报告。
3. 接入一个 OpenAI-compatible Provider，实现统一错误、流式响应、用量和预算约束。
4. 实现确定性 Evaluator 和有限重试策略。
5. 接入第二个 Provider 和 Policy Router，再实现任务图与头部模型拆解。
6. 增加事件流、OpenTelemetry/Langfuse 兼容追踪、成本报告和操作面板。
7. 只有 PostgreSQL 队列的实测数据证明不足时，才评估 Temporal 或独立队列。

## 9. 工程规则

- 保持 TypeScript `strict`；外部数据以 `unknown` 接收并验证。
- 保持 adapter 边界，并通过 Provider/Repository 契约测试约束。
- 返回类型化领域错误，不通过匹配任意错误字符串判断行为。
- 注释解释不变量、权衡和不明显的安全约束，不复述语法。
- 测试优先覆盖状态迁移、幂等、所有权、取消、预算、错误映射和上下文完整性。
- 性能变更需报告吞吐、P50/P95 延迟、错误率和资源成本。
- 在削弱边界之前，优先优化上下文体积、序列化、连接复用和批处理。
- 禁止把密钥、无限制提示内容或工具输出写入任务记录、日志或交接信息。

