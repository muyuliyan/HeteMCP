# HeteMCP

HeteMCP 是一个面向个人多模型工作流的、供应商无关的 MCP 编排服务。

- [架构与工程规范](docs/architecture.md)
- [上下文治理与交接 Skill](skill/heteromcp-context-governance/SKILL.md)

## 当前实现

- 严格类型的任务、上下文、产物和执行结果协议
- 受状态机约束的 Orchestrator，支持幂等创建、执行去重、超时和取消
- 带 revision 检查的内存与 PostgreSQL 任务仓储
- 基于原子 claim、heartbeat 和 lease 过期重排的任务恢复
- 与供应商 SDK 解耦的 `ModelProvider` 接口及确定性 fake provider
- 基于 stdio 的 MCP Server
- 状态迁移、幂等、验收、取消、超时和 MCP 端到端测试

当前提供以下 MCP 工具：

| 工具              | 用途                        |
| ----------------- | --------------------------- |
| `create_task`     | 幂等创建任务并安排后台执行  |
| `get_task`        | 查询任务状态和 attempt 信息 |
| `cancel_task`     | 请求取消任务                |
| `get_task_result` | 获取任务产物和验收结果      |

## 开发与运行

```bash
npm install
npm run check
npm run build
npm start
```

MCP 客户端应通过 `node dist/index.js` 启动服务。开发时可运行 `npm run dev`。

`npm run check` 会依次执行类型检查、ESLint、格式检查和全部测试。

默认使用内存存储。需要持久化时，创建 PostgreSQL 数据库并设置：

```bash
HETEMCP_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/heteromcp
```

服务启动时会自动执行幂等迁移，并恢复 lease 已过期的任务。测试使用 PGlite 验证 PostgreSQL 迁移、JSONB 和事务语义，无需本地 Docker。

## 当前限制

- 未设置 `HETEMCP_DATABASE_URL` 时，任务只保存在内存中。
- fake provider 只用于验证编排链路，不会调用真实模型或执行代码修改。
- 隔离 worker 和真实模型 adapter 将在后续里程碑实现。
