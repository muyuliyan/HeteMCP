# HeteMCP 初步设计

## 1. 目标与边界

HeteMCP 是面向个人开发工作流的异构模型编排服务。头部模型负责计划、路由、验收与升级；工作模型通过统一接口执行有边界的任务；Codex 或其他 MCP 客户端负责交互和查看状态。

首个版本只解决一条可靠链路：

`MCP client -> orchestrator -> provider adapter -> isolated worker -> artifact/test result -> reviewer`

首版不做模型自治组织、复杂投票、跨节点调度和通用工作流语言。系统先保证任务可恢复、状态可解释、权限可约束、结果可验证，再扩展智能路由。

## 2. 设计原则

- **控制面与执行面分离**：控制面保存状态和策略；执行面可以失败、重启和替换。
- **端口稳定，供应商可换**：核心只认识内部协议，OpenAI、DeepSeek、GLM 等差异留在 adapter。
- **模型提出，程序裁决**：预算、权限、状态迁移、重试和验收由确定性代码执行。
- **产物优先于对话**：以 patch、commit、测试报告和结构化结果作为事实来源。
- **按证据优化性能**：先埋点再优化；允许批处理、流式输出和缓存，但不穿透组件边界。
- **失败必须显式**：不静默降级，不无限重试，不把部分完成标记为成功。

## 3. 组件边界

| 组件 | 职责 | 不应承担 |
|---|---|---|
| MCP Gateway | 暴露任务创建、查询、取消和结果读取工具 | 模型路由与业务状态判断 |
| Orchestrator | 状态机、依赖、租约、重试、超时和恢复 | 供应商 SDK 细节 |
| Policy Router | 根据能力、成本、延迟和风险给出候选 worker | 绕过权限或验收规则 |
| Provider Adapter | 统一模型调用、流式事件、用量和错误分类 | 修改任务状态 |
| Worker Runtime | 在隔离目录执行工具并生成产物 | 读取未授权路径或长期保存密钥 |
| Evaluator | 运行测试、规则检查和可选模型审查 | 用主观评分替代硬性验收 |
| Event Store | 保存任务、attempt、事件和产物引用 | 保存完整敏感提示词或大块日志 |

MVP 建议采用 TypeScript、Node.js、官方 MCP SDK、PostgreSQL 和单进程 worker。队列先用 PostgreSQL 的租约式领取实现；只有吞吐或可靠性数据证明不足时，再引入 Temporal 或独立消息队列。

## 4. 核心协议

所有跨组件数据均使用带版本的 schema，并在入口验证。内部 ID 使用不可猜测的字符串；时间使用 UTC ISO 8601；金额使用整数最小货币单位，token 使用整数。

```ts
type TaskStatus =
  | "queued"
  | "running"
  | "blocked"
  | "reviewing"
  | "succeeded"
  | "failed"
  | "cancelled";

interface TaskSpecV1 {
  version: 1;
  objective: string;
  allowedPaths: string[];
  excludedPaths: string[];
  acceptance: string[];
  workerProfile: string;
  budget: { maxInputTokens: number; maxOutputTokens: number; maxCostMicros: number };
  timeoutMs: number;
  context: ContextEnvelopeV1;
}

interface ContextEnvelopeV1 {
  summary: string;
  decisions: Array<{ choice: string; reason: string }>;
  evidence: Array<{ source: string; fact: string }>;
  openQuestions: string[];
}

interface AttemptResultV1 {
  status: "succeeded" | "failed" | "blocked";
  summary: string;
  artifacts: Array<{ kind: "patch" | "commit" | "test-report" | "log"; uri: string }>;
  checks: Array<{ name: string; outcome: "passed" | "failed" | "skipped"; evidence?: string }>;
  usage: { inputTokens: number; outputTokens: number; costMicros: number };
  error?: { code: string; retryable: boolean; message: string };
}
```

任务状态只能由 Orchestrator 迁移。每次执行生成独立 `attemptId`；重复提交通过 `idempotencyKey` 去重；worker 通过有期限的 lease 领取任务。取消是状态请求，不假设进程立刻停止，执行面必须定期检查取消信号。

## 5. 上下文策略

上下文分三层：

1. **固定层**：仓库规则、工具权限、schema 与安全边界，按版本引用。
2. **任务层**：目标、范围、验收、预算和用户明确决策，不允许摘要改变语义。
3. **工作层**：探索记录、工具输出和中间推理，可压缩或丢弃。

压缩器只输出 `ContextEnvelopeV1`，保留决定及理由、可追溯证据、未解决问题和下一步。原始大型输出写入 artifact store，摘要只保留引用。接收模型必须重新读取关键文件和 Git 状态，禁止把上一个模型的推断当作已验证事实。

## 6. 可靠性、安全与可观测性

- Provider 错误统一分类为：认证、限流、超时、上下文超限、内容拒绝、临时上游错误和永久请求错误。
- 仅对明确可重试错误退避重试，并受 attempt 数、截止时间和预算三重限制。
- API key 只从运行时 secret provider 注入；日志、事件、提示词快照默认脱敏。
- Worker 使用独立 worktree 或容器；路径白名单在工具层校验，不能只写在 prompt 中。
- 每个事件携带 `traceId`、`taskId`、`attemptId`、provider、model、阶段、耗时和累计用量。
- 日志记录状态变化与外部调用摘要；高基数字段进入 trace，不进入指标标签。

至少监控：排队时长、端到端时长、首 token 延迟、成功率、重试率、取消响应时间、各 provider 错误率、token 与成本、上下文压缩前后大小。

## 7. 性能与架构的协调

架构边界使用进程内接口实现，不为“分层”提前拆微服务。调用链路保持异步并支持流式事件；数据库写入按状态变化和有界批次落盘，避免逐 token 持久化。大对象存 artifact store，数据库只保存元数据和内容哈希。

缓存键必须包含 provider、model、参数、工具版本和上下文哈希；涉及可变仓库状态的结果默认不缓存。并发由 provider、用户预算和 worker 容量共同限流，避免单一全局锁。任何绕过校验、审计或适配器的“快速路径”都不接受；任何新增网络跳转或基础设施也需要基准数据支持。

性能变更至少报告吞吐、P50/P95 延迟、错误率和资源成本。优先优化序列化次数、上下文体积、连接复用和批处理，最后才牺牲清晰边界。

## 8. 代码与文档风格

- TypeScript 开启 `strict`；核心领域不得使用裸 `any`，外部输入以 `unknown` 接收并验证。
- 文件按领域组织，依赖方向为 `transport -> application -> domain`，provider 和存储实现位于基础设施层。
- 函数名描述行为，类型名描述概念；布尔值使用 `is/has/can/should` 前缀。
- 公开接口返回显式结果或领域错误，不依赖字符串匹配异常。
- 注释写“为什么”和不变量，例如重试为何安全、顺序为何必要；明显代码不写注释。
- 测试以行为命名，优先覆盖状态迁移、幂等、取消、预算耗尽、adapter 错误映射和上下文压缩不变量。
- 文档记录稳定契约与决策理由，不同步抄写实现。示例必须能与当前 schema 对应。

建议使用 ESLint、Prettier、Vitest、Zod 和依赖边界检查。格式由工具统一，评审精力留给行为、边界和失败模式。

## 9. 常见错误与防线

| 容易发生的错误 | 防线 |
|---|---|
| 把模型回复等同于执行成功 | 必须有 artifact 与 acceptance check 证据 |
| Provider 字段泄漏到核心领域 | adapter 做双向映射，contract test 固定边界 |
| 重试造成重复修改或重复扣费 | idempotency key、attempt 隔离、重试预算 |
| 摘要丢失限制或把猜测写成事实 | 分层上下文、证据引用、`unknown` 显式化 |
| 多 worker 同时写同一工作区 | worktree/container 隔离与任务级写租约 |
| 为通用性提前建立复杂 DSL | 先稳定版本化 TaskSpec，再由真实需求扩展 |
| 逐 token 写库拖垮系统 | 内存有界缓冲，按时间或大小批量提交 |
| 日志泄露密钥或完整源码 | 字段白名单、脱敏、产物权限和保留周期 |

## 10. 实施顺序

1. 建立领域 schema、状态机和 adapter contract tests。
2. 实现 MCP Gateway、内存仓储及一个 fake provider，跑通确定性端到端测试。
3. 接入 PostgreSQL、lease、幂等、取消和恢复。
4. 接入一个真实 provider 与隔离 worker，产出 patch 和测试报告。
5. 增加第二个 provider、策略路由、成本和追踪面板。
6. 数据证明有必要后，再评估 Temporal、多进程部署和模型评审。

首个里程碑的完成定义：任务可创建、查询和取消；进程重启后不丢状态；同一请求不会重复执行；provider 可替换；失败原因可分类；一次受限代码任务能生成可验证产物。

