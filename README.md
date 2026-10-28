# HeteMCP

HeteMCP 是面向个人多模型工作流的、供应商无关的 MCP 编排服务。当前已打通 Codex 监督、DeepSeek Harness（DSH）执行的单文件生成链路，并提供可恢复的任务编排与 PostgreSQL 持久化。

- [Architecture and engineering rules](docs/architecture.md)（实现规范，以英文版为准）
- [架构与工程规范（中文）](docs/architecture.zh-CN.md)
- [上下文治理与交接 Skill](skill/heteromcp-context-governance/SKILL.md)
- [DSH 配置、复现与验收](docs/deepseek-smoke.md)
- [仓库文件、归档与发布约定](docs/repository-layout.md)

## 当前能力与边界

```text
Codex / MCP client
  -> MCP stdio -> Orchestrator -> TaskExecutor
  -> 独立 attempt 空目录 -> AgentHarness -> DSH
  -> 文件范围检查 + SHA-256 产物 -> 任务结果
  -> Codex 独立编译 / 行为验收 -> 显式发布
```

- strict TypeScript / Zod 协议、幂等创建、执行去重、超时、取消及验收状态机。
- 内存 / PostgreSQL 仓储、revision 检查、原子 claim、heartbeat、lease 过期回收和旧结果拒绝。
- 默认 fake executor 用于编排测试；显式配置后使用 DSH Desktop `0.2.1-rc.2` 兼容模式。
- `deepseek-file-generation` 每次只生成一个 `.cpp`、`.txt` 或 `.md` 普通文件，非空且不超过 128 KiB；保存源码与报告的 SHA-256。
- 已有真实 MCP → DSH → C++ 产物验收记录，详见 [smoke test](docs/deepseek-smoke.md)。

`succeeded` 在文件生成模式中只证明 Harness 完成且 `generated-file-scope` 通过；编译、数值正确性与性能需要单独验收。当前不提供通用仓库修改、自动合并、强制 token/费用预算、策略路由或 MCP 进度流。Codex 是监督客户端，仓库没有 Codex 执行 adapter。

## 开发与运行

需要 Node.js 22+。在仓库根目录运行：

```powershell
npm ci
npm run check
npm run build
npm start
```

`npm run check` 包含类型检查、ESLint、Prettier 和快速测试（包括基于 PGlite 的仓储契约测试）。开发模式使用 `npm run dev`。MCP 客户端启动命令为 `node <仓库绝对路径>/dist/index.js`，工作目录必须为仓库根目录，以解析 policy 和运行目录；stdio 留给协议，启动诊断写入 stderr。

## 启用 DSH

将以下路径替换为本机安装与凭据文件的位置；不把密钥写入任务或仓库：

```powershell
$env:HETEMCP_DSH_DESKTOP = 'D:/path/to/deepseek-desktop'
$env:HETEMCP_CREDENTIALS_PATH = 'C:/path/to/.credentials.yaml'
$env:HETEMCP_ALLOW_UNMETERED = '1'
node node_modules/tsx/dist/cli.mjs scripts/run-file-task.ts config/bubble-task.json
```

先执行 `npm run build`。脚本通过真实 MCP stdio 调用服务，保存 `.heteromcp/runs/<task-id>.json`；不会自动发布生成文件。完整编译、行为测试与 `--publish` 步骤见 [DSH 操作说明](docs/deepseek-smoke.md)。

| 环境变量                    | 行为                                                                                |
| --------------------------- | ----------------------------------------------------------------------------------- |
| `HETEMCP_DSH_DESKTOP`       | 启用 Desktop 兼容 executor；未设置则使用 fake                                       |
| `HETEMCP_CREDENTIALS_PATH`  | 原生 credentials plugin 读取的文件路径                                              |
| `HETEMCP_ALLOW_UNMETERED=1` | 显式接受未计量模式；`usage.measured=false` 表示未知而非免费，墙钟超时仍强制执行     |
| `HETEMCP_DATABASE_URL`      | 设置则使用 PostgreSQL；未设置则任务仅存在于当前进程内存                             |
| `HETEMCP_ARTIFACT_ROOT`     | 可选源码/报告目录，默认 `.heteromcp/artifacts`；自定义目录需自行备份并配置 Git 忽略 |

服务不会自动加载 `.env`；配置须进入实际服务进程环境。`run-file-task.ts` 显式转发上述变量，包括数据库连接。

## MCP 工具

| 工具              | 参数                     | 用途                                |
| ----------------- | ------------------------ | ----------------------------------- |
| `create_task`     | `{idempotencyKey, task}` | 幂等创建并安排后台执行              |
| `get_task`        | `{taskId}`               | 查询状态、attempt、lease 及已有结果 |
| `cancel_task`     | `{taskId}`               | 请求取消任务                        |
| `get_task_result` | `{taskId}`               | 返回完整任务记录及产物/检查         |

成功响应在 `structuredContent.task`，调用方先检查 `isError`。任务协议见 [schemas.ts](src/domain/schemas.ts)，示例见 [bubble-task.json](config/bubble-task.json)。相同提交重发复用 idempotency key；有意新执行使用新 key。示例脚本每次生成新 key，通过轮询获取结果。

## 数据库与验证

设置 `HETEMCP_DATABASE_URL` 后，服务自动执行幂等 migration，Worker Loop 回收过期 lease 并消费队列。数据库保存任务与产物引用，产物文件需另外备份。

```powershell
npm run test:integration:docker
```

该命令运行真实 PostgreSQL 并发、恢复和 migration 测试，并清理测试容器与数据卷。`npm run db:up` / `npm run db:down` 用于本地测试容器；仓库 Compose 使用 **tmpfs 临时数据库**，不能作为持久化部署模板。已有持久化实例应单独管理，勿用测试清理命令管理其数据。

## 文件与归档

GitHub 保留源码、测试、可复现配置、示例及维护中的文档。`node_modules/`、`dist/`、`.heteromcp/`、凭据、日志和中间二进制均不上传；`package-lock.json` 和已验收的 `test/bubble.cpp` 保留。

项目外 MLA 实验记录与专用交接已归入本地 `.heteromcp/archive/2026-10-28/`，附原路径和 SHA-256 清单。运行时 artifacts、会话与数据库未迁移。Git push 不备份这些本地材料，归档与备份规则见 [文件管理约定](docs/repository-layout.md)。
