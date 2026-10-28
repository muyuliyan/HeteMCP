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

| 组件             | 负责                                     | 不应负责                   |
| ---------------- | ---------------------------------------- | -------------------------- |
| MCP Gateway      | 工具 Schema 和传输层                     | 路由或任务状态决策         |
| Orchestrator     | 状态机、超时、取消、验收、租约所有权     | 供应商 SDK 细节            |
| Worker Loop      | 任务恢复和队列消费                       | 领域策略                   |
| Policy Router    | 根据能力、成本、延迟和风险选择候选模型   | 绕过权限                   |
| Provider Adapter | 模型调用、流式响应、用量和错误映射       | 保存任务状态               |
| Worker Runtime   | 隔离工具、仓库修改和产物生成             | 不受限地访问宿主机         |
| Evaluator        | 测试、规则检查、确定性验收和可选模型审查 | 用主观评价替代硬证据       |
| Task Repository  | 原子 claim、revision 检查和 lease 持久化 | 业务状态决策               |
| Artifact Store   | patch、日志、报告、哈希和保留策略        | 把大对象塞入任务行         |
| Event/Telemetry  | 可追踪事件、指标和成本                   | 保存密钥或无限制的提示内容 |

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

## 5. 已实现基线

当前支持的链路是受监督的单文件生成：

`Codex/MCP 客户端 -> MCP stdio -> Orchestrator -> TaskExecutor -> FileGenerationExecutor -> AgentHarness -> DSH -> 范围检查/产物 -> 结果 -> supervisor 验收/发布`

Codex 是协调客户端，尚无 Codex 执行 adapter。`TaskExecutor` 是应用执行端口，`ModelProvider` 保留为兼容别名；`AgentHarness` 只报告进程/会话结果，不提供权威验收。第 3 节的策略路由、通用 Worker、Artifact Service 和 Evaluator 是目标边界，通用实现仍待完成。

已实现能力：

- strict TypeScript / Zod 的任务、上下文、产物、检查、用量和结果协议；
- 幂等创建、执行去重、超时、取消及验收状态迁移；
- `create_task`、`get_task`、`cancel_task`、`get_task_result` 四个 MCP stdio 工具；
- 内存/PostgreSQL 仓储、revision 检查、原子 claim（`FOR UPDATE SKIP LOCKED`）、heartbeat、lease 回收和旧结果拒绝；
- 启动恢复与队列消费循环、事务串行化的幂等 migration；
- 默认确定性 fake 执行，以及显式启用的 DSH Desktop `0.2.1-rc.2` 文件生成；
- 无 shell 的子进程调用、有限 NDJSON/诊断、session/final 校验和进程树取消；
- 独立 attempt 空工作区、独立文件范围检查、带 SHA-256 的源码和报告引用；
- 真实 MCP 客户端脚本、独立 C++ 编译/行为验收和显式发布；
- 领域、编排、进程协议、文件范围、传输及共享仓储契约测试，以及独立真实 PostgreSQL 集成测试。

验证命令为 `npm run check`、`npm run build`；真实 PostgreSQL 使用 `npm run test:integration:docker`。测试数量和依赖审计结果属于某次运行证据，不是永久架构保证。真实 DSH 证据见 [deepseek-smoke.md](deepseek-smoke.md)；模拟子进程测试不能证明真实模型连通。

## 6. 运行与持久化决策

### 配置与 Codex 监督

从仓库根目录启动服务，policy 与私有运行目录均按 cwd 解析。MCP 命令为 `node <仓库绝对路径>/dist/index.js`，stdout 仅承载协议。Codex 或其他 MCP 客户端负责传入实际服务环境；服务不会自动加载 `.env`。

`HETEMCP_DSH_DESKTOP` 启用真实文件生成，同时要求 `HETEMCP_CREDENTIALS_PATH` 和显式 `HETEMCP_ALLOW_UNMETERED=1`；缺少 desktop 变量则使用 fake。`HETEMCP_DATABASE_URL` 独立决定是否使用 PostgreSQL，否则记录仅存在于当前进程。`scripts/run-file-task.ts` 显式转发以上变量及可选的 `HETEMCP_ARTIFACT_ROOT`。自定义 MCP 客户端若遗漏 transport 环境，父进程设置变量也不能保证生效。

四个工具成功时均在 `structuredContent.task` 返回完整记录，读取前先检查 `isError`。`get_task_result` 不执行编译，也不等待完成。示例客户端通过轮询和 supervisor 截止时间等待，超时请求取消；每次启动生成新 idempotency key，重发同一提交的客户端应复用原 key。

### DSH Desktop 兼容

固定版本的 desktop adapter 以 `ELECTRON_RUN_AS_NODE=1` 启动 `DeepSeek Harness.exe`，执行包内 `resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js`。使用绝对可执行/入口路径、stdin 提示和显式环境，不通过 npm `.cmd` 或 shell 插值启动。

Desktop `0.2.1-rc.2` 不支持现代 `--permission-mode` 参数。显式 legacy 模式使用 `--profile headless --patch ...` 和[已核对的 overlay](../config/deepseek-desktop-0.2.1.patch.yml)：workspace-write、approval never、原生凭据路径、`deepseek-official/deepseek-flash`，禁用 shell/web/委派/插件管理工具。运行使用私有 `.heteromcp/dsh-home`，不修改个人 profile。凭据由原生 plugin 加载，不嵌入任务。

根据已检查的 runner 语义，旧版完成需初始 session、合法 legacy final 和退出码 0；现代模式还要求 completed final reason 和匹配的 session 身份。禁止因输出格式错误自动降级 legacy 校验。支持其他版本前重新验证 CLI、协议和 policy，help 成功不足以证明兼容。当前不自动重试模型调用，也不扩大权限降级执行。

### 文件生成与验收

executor 只接受 `workerProfile=deepseek-file-generation`、一个 `.cpp`/`.txt`/`.md` 普通文件名、空 excludedPaths 和唯一 `generated-file-scope` 验收项。每个 attempt 创建全新空目录，不暴露 checkout；独立确认只有一个非空普通文件且不超过 128 KiB，保存源码与报告 SHA-256 引用。

`HarnessOutcome.completed` 只证明回合完成；该模式的任务 `succeeded` 证明回合完成且文件范围验收通过。两者都不证明编译、行为、数值正确或性能。supervisor 独立验收后显式发布；用户要求由 DSH 编码时保留其原始字节。`scripts/verify-bubble.ts` 验证源码哈希并编译测试，仅在 `--publish` 时发布，拒绝覆盖非空目标。

该模式的 V1 token/费用上限仅为提示；`usage.measured=false` 与零计数表示未知而非免费。必须显式启用未计量模式，墙钟超时仍强制执行。通用验收命令、资源上限与仓库 patch 验收仍待实现。

### PostgreSQL 与产物保留

| 关注点         | 决策                                                                                                                                                 |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 快速反馈       | PGlite 无需 Docker 即可运行共享仓储契约测试。                                                                                                        |
| 真实数据库     | PostgreSQL 17 集成测试覆盖独立连接 claim、断连/重启、heartbeat、并发 migration 和索引计划。                                                          |
| migration 安全 | 事务级 advisory lock 串行化 metadata 建表和各 migration。                                                                                            |
| 本地 Compose   | `compose.yaml` 使用 tmpfs 与测试凭据，`db:up`/`db:down` 用于可丢弃开发环境，不是持久化部署或备份；集成 runner 清理其测试容器/卷。                    |
| 持久化部署     | 通过 `HETEMCP_DATABASE_URL` 连接单独管理的数据库，存储、密钥和备份独立于临时测试环境。                                                               |
| 产物           | 数据库保存任务状态和产物引用；文件默认位于 `.heteromcp/artifacts/<task>/<attempt>/`，客户端快照位于 `.heteromcp/runs/`。数据库持久化不等于文件备份。 |

Worker 恢复针对 lease 过期及旧 owner，不承诺外部执行恰好一次。整理文件不能迁移/删除仍被引用的产物和会话目录。任务记录与文件一起备份，恢复后核对 URI 和哈希。

## 7. 后续工作

| 能力              | 剩余范围                                                                             |
| ----------------- | ------------------------------------------------------------------------------------ |
| 通用 Worker       | 仓库 worktree/container、运行时路径/命令策略、资源边界、清理与 patch 收集            |
| 验收              | 版本化结构化命令、通用 build/test evaluator 与 patch 范围检查                        |
| Artifact Service  | 超出本地哈希文件的持久存储、访问控制、保留和备份恢复工具                             |
| 模型推理 Provider | OpenAI-compatible 推理 adapter、流式响应、计量和统一错误；DSH agent 执行已经单独接入 |
| 预算/重试         | token/费用强制上限、有限退避、截止时间与 attempt 策略                                |
| MCP 交互          | 服务端有限等待与游标进度；当前客户端轮询                                             |
| 路由/任务图       | 能力/成本/风险选择、fallback、依赖、汇总与拆解                                       |
| 上下文/可观测性   | 自动压缩/交接校验、生命周期事件、trace、指标和费用统计                               |
| 服务安全          | 认证、租户隔离、密钥管理与生产保留控制                                               |

验收或工作区语义变化时引入版本化协议，保留已有 V1 记录。Git worktree 隔离修改，不是宿主文件系统沙箱。当前文件生成模式是已支持的有限工作流，不是通用生产 Worker。

## 8. 仓库与交付约定

文件归属与保留规则见 [repository-layout.md](repository-layout.md)。Git 跟踪源码、测试、可复用脚本、脱敏配置、lockfile、维护文档/Skill 及已验收的 `test/bubble.cpp`。依赖、构建、凭据、原始会话、任务快照、实验脚本和任务专用交接留在本地忽略目录。

2026-10-28 将 8 份 MLA 实验报告及其任务专用 Skill 归档至私有 `.heteromcp/archive/2026-10-28/`，附原路径与 SHA-256 清单。这些项目外负载的历史记录不作为当前工程规范。已有产物/运行路径保持原位以保全引用。Git push 不备份本地归档和任务数据。

稳定契约变更时同步中英文架构、README 操作说明和治理 Skill。不向这些文档复制完整运行记录、本机凭据或个人绝对路径；历史证据摘要与当前能力分开说明。

下一步交付优先级：

1. 保持已工作的 MCP/DSH 生成链路与恢复契约。
2. 引入版本化验收/工作区语义和通用独立 evaluator。
3. 增加有限等待、进度与可复用客户端交互。
4. 扩展仓库 Worker、持久产物管理、可计量预算与有限重试。
5. 按实际需求增加 Provider/路由、任务图和可观测性；仅在实测 PostgreSQL 瓶颈后评估独立队列。

## 9. 工程规则

- 保持 TypeScript `strict`；外部数据以 `unknown` 接收并验证。
- 保持 adapter 边界，并通过 Provider/Repository 契约测试约束。
- 返回类型化领域错误，不通过匹配任意错误字符串判断行为。
- 注释解释不变量、权衡和不明显的安全约束，不复述语法。
- 测试优先覆盖状态迁移、幂等、所有权、取消、预算、错误映射和上下文完整性。
- 性能变更需报告吞吐、P50/P95 延迟、错误率和资源成本。
- 在削弱边界之前，优先优化上下文体积、序列化、连接复用和批处理。
- 禁止把密钥、无限制提示内容或工具输出写入任务记录、日志或交接信息。
