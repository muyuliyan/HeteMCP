# HeteMCP

HeteMCP 是面向个人多模型工作流的、供应商无关的 MCP 编排服务。它在同一任务协议下调度 **Claude Code**、**Codex**、**DeepSeek Harness（DSH）** 或确定性 fake，并提供 **派遣（dispatch）**、**互检（mutual-check）** 与 **工作流（workflow / workflaw）** 三种执行模式。

- [Architecture and engineering rules](docs/architecture.md)（实现规范，以英文版为准）
- [架构与工程规范（中文）](docs/architecture.zh-CN.md)
- [上下文治理与交接 Skill](skill/heteromcp-context-governance/SKILL.md)
- [DSH 配置、复现与验收](docs/deepseek-smoke.md)
- [仓库文件、归档与发布约定](docs/repository-layout.md)

## 当前能力与边界

```text
Claude Code / Codex / MCP client
  -> MCP stdio 或 Streamable HTTP
  -> Orchestrator -> ModeRoutingExecutor
  -> dispatch:      Claude / Codex / DSH / fake -> 隔离 workspace -> 文件范围检查 + SHA-256
  -> mutual-check:  指定 reviewer 独立审查 -> 交叉复审 -> checks + reviews
  -> workflow:      dispatch 成功后自动执行 mutual-check
  -> 结果 -> 监督端独立编译 / 行为验收 -> 显式发布
```

- strict TypeScript / Zod 协议、幂等创建、执行去重、超时、取消及验收状态机。
- 内存 / PostgreSQL 仓储、revision 检查、原子 claim、heartbeat、lease 过期回收和旧结果拒绝。
- 三个执行模式共享同一任务协议；默认模式始终是 `dispatch`，不会静默降级成 fake 或其他 agent。
- `deepseek-file-generation`、`claude-file-generation`、`codex-file-generation` 与通用 `file-generation` 只生成一个 `.cpp`、`.txt` 或 `.md` 普通文件，非空且不超过 128 KiB；保存源码与报告的 SHA-256。
- `mutual-check` 由 1–8 个指定 reviewer 审查文件产物；2 个及以上 reviewer 时，每轮 reviewer 会看到其他 reviewer 的结论并给出最终裁决。所有最终裁决通过才算通过。
- `workflow` 先派遣再互检；`workflaw` 是兼容别名。
- MCP 可通过 stdio 或本地 Streamable HTTP 端口接入；CC-switch 可直接导入生成的 `mcpServers` 配置。
- `succeeded` 只证明声明的 acceptance 已通过。文件生成模式不包含编译、数值正确性与性能验收；这些仍需监督端独立完成。

当前不提供通用仓库修改、自动合并、强制 token/费用预算或 MCP 进度流。互检是模型评审证据，不是编译或运行时证明；确定性聚合只保证“所有 reviewer 的最终裁决都通过”。

## 模式与 worker

| 模式         | `mode`                  | 行为                                                                                      |
| ------------ | ----------------------- | ----------------------------------------------------------------------------------------- |
| 派遣（默认） | `dispatch`              | 一个 worker 生成文件；acceptance 至少包含 `generated-file-scope`                          |
| 互检         | `mutual-check`          | 对已有任务的产物做独立审查与交叉复审；需要 `sourceTaskId`，acceptance 仅含 `mutual-check` |
| 工作流       | `workflow` / `workflaw` | 先派遣再互检；acceptance 仅允许 `generated-file-scope`、`mutual-check`                    |

任务通过 `worker` / `reviewers` 指定具体模型：

```json
{
  "workerProfile": "file-generation",
  "worker": { "agent": "claude", "model": "sonnet" },
  "mode": "workflow",
  "reviewers": [{ "agent": "codex" }, { "agent": "claude", "model": "opus" }]
}
```

派遣完成后单独发起互检，可直接调用便捷工具：

```json
{
  "idempotencyKey": "review-1",
  "sourceTaskId": "00000000-0000-4000-8000-000000000000",
  "reviewers": [{ "agent": "claude" }, { "agent": "codex", "model": "gpt-5" }]
}
```

- `workerProfile` 可以是 `file-generation`（配合 `worker` 或 `HETEMCP_DEFAULT_WORKER`）、`claude-file-generation`、`codex-file-generation`、`deepseek-file-generation` 或 `fake`。
- 独立互检任务使用 `workerProfile: "mutual-check"`、`mode: "mutual-check"` 与 `sourceTaskId`。
- `agent` 名由 `HETEMCP_AGENTS` 和自动探测决定；`model` 交给对应 CLI（Claude `--model` / Codex `--model`）。
- 未配置的 agent 会出现在 `list_workers` 中并附带原因；被任务选中时直接报错，不会回退到 fake。

## 开发与运行

需要 Node.js 22+。在仓库根目录运行：

```powershell
npm ci
npm run check
npm run build
npm start
```

`npm run check` 包含类型检查、ESLint、Prettier、私有痕迹守卫和快速测试（含 PGlite 仓储契约测试）。开发模式使用 `npm run dev`。MCP 客户端启动命令为 `node <仓库绝对路径>/dist/index.js`；服务现在以模块位置解析仓库根目录，不再要求客户端 cwd 必须是仓库根目录。stdio 留给协议，启动诊断写入 stderr。

## Agent 配置

`HETEMCP_AGENTS=auto`（默认）会自动探测：

- **Claude Code**：PATH 中的 `claude.exe`，或 `~/.local/bin/claude.exe`；可用 `HETEMCP_CLAUDE_EXECUTABLE` 显式指定。
- **Codex**：`%LOCALAPPDATA%/OpenAI/Codex/bin/*/codex.exe`，或 PATH 中的 `codex.exe`；可用 `HETEMCP_CODEX_EXECUTABLE` 显式指定。
- **DSH**：仅当设置 `HETEMCP_DSH_DESKTOP`、`HETEMCP_CREDENTIALS_PATH` 和 `HETEMCP_ALLOW_UNMETERED=1` 时启用。

两个 worker 都会隔离用户 MCP 配置（Claude `--strict-mcp-config`、Codex `-c mcp_servers={}`），避免 worker 反向调用 HeteMCP。

```powershell
$env:HETEMCP_AGENTS = 'auto'
$env:HETEMCP_CLAUDE_MODEL = 'sonnet'
$env:HETEMCP_CODEX_MODEL = 'gpt-5'
npm start
```

DSH 的完整配置、复现与验收步骤见 [DSH 操作说明](docs/deepseek-smoke.md)。服务不会自动加载 `.env`；配置须进入实际服务进程环境。`scripts/run-file-task.ts` 会显式转发上述变量。

| 环境变量                             | 行为                                                                 |
| ------------------------------------ | -------------------------------------------------------------------- |
| `HETEMCP_AGENTS`                     | `auto`（默认）或逗号分隔的 `claude,codex,deepseek,fake`              |
| `HETEMCP_DEFAULT_WORKER`             | `workerProfile: file-generation` 且未指定 `worker` 时使用的 agent    |
| `HETEMCP_CLAUDE_EXECUTABLE`          | Claude Code CLI 绝对路径；必须是原生 `.exe`                          |
| `HETEMCP_CLAUDE_MODEL`               | Claude 默认模型                                                      |
| `HETEMCP_CODEX_EXECUTABLE`           | Codex CLI 绝对路径；必须是原生 `.exe`                                |
| `HETEMCP_CODEX_MODEL`                | Codex 默认模型                                                       |
| `HETEMCP_DSH_DESKTOP`                | 启用 Desktop 兼容 DSH executor；需同时提供凭据与未计量确认           |
| `HETEMCP_CREDENTIALS_PATH`           | 原生 credentials plugin 读取的文件路径                               |
| `HETEMCP_ALLOW_UNMETERED=1`          | 显式接受未计量模式；`usage.measured=false` 表示未知而非免费          |
| `HETEMCP_DATABASE_URL`               | 设置则使用 PostgreSQL；未设置则任务仅存在于当前进程内存              |
| `HETEMCP_ARTIFACT_ROOT`              | 可选源码/报告目录，默认 `.heteromcp/artifacts`；相对路径按仓库根解析 |
| `HETEMCP_ALLOW_EXTERNAL_ARTIFACTS=1` | 允许互检读取 artifact root 之外的 `file:` 产物（默认拒绝）           |

## MCP 工具

| 工具                  | 参数                                                                | 用途                                             |
| --------------------- | ------------------------------------------------------------------- | ------------------------------------------------ |
| `create_task`         | `{idempotencyKey, task}`                                            | 按 `task.mode` 创建并安排任务                    |
| `create_workflow`     | `{idempotencyKey, task, reviewers}`                                 | 便捷创建“派遣 + 互检”任务，自动补 `mutual-check` |
| `create_mutual_check` | `{idempotencyKey, sourceTaskId, reviewers, objective?, timeoutMs?}` | 对已有任务的产物创建互检任务                     |
| `list_workers`        | `{}`                                                                | 列出模式与 agent 可用性                          |
| `get_task`            | `{taskId}`                                                          | 查询状态、attempt、lease 及已有结果              |
| `cancel_task`         | `{taskId}`                                                          | 请求取消任务                                     |
| `get_task_result`     | `{taskId}`                                                          | 返回完整记录、checks、reviews 与产物             |

成功响应在 `structuredContent.task`（`list_workers` 为 `structuredContent.catalog`），调用方先检查 `isError`。任务协议见 [schemas.ts](src/domain/schemas.ts)，工作流示例见 [workflow-task.json](config/workflow-task.json)。相同提交重发复用 idempotency key；有意新执行使用新 key。

互检产物与 review JSON 保存在 `.heteromcp/artifacts/<task>/<attempt>/reviews/`；reviewer 只能修改自己的工作副本，代码会校验候选文件哈希未被篡改。

## 运行示例

```powershell
npm run build
node node_modules/tsx/dist/cli.mjs scripts/run-file-task.ts config/workflow-task.json
```

脚本通过真实 MCP stdio 调用服务，轮询到终态并把完整记录保存到 `.heteromcp/runs/<task-id>.json`；不会自动发布生成文件。

## CC-switch 与 HTTP MCP

构建后生成可直接导入 CC-switch 的配置：

```powershell
npm run build
npm run mcp:cc-switch
```

输出位于 `.heteromcp/cc-switch/`：

- `heteromcp.stdio.json`：stdio 入口，包含本机 node、仓库绝对路径和已探测的 agent 路径。
- `heteromcp.http.json`：本地 Streamable HTTP 入口。
- `heteromcp.mcp.json`：两者合并。

在 CC-switch 的 MCP 页面导入对应文件即可。HTTP 入口需要先启动服务：

```powershell
npm run start:http
```

默认端点为 `http://127.0.0.1:8787/mcp`，健康检查为 `http://127.0.0.1:8787/healthz`。可用环境变量或命令行调整：

```powershell
node dist/index.js --transport http --host 127.0.0.1 --port 8787 --path /mcp
$env:HETEMCP_MCP_TOKEN = 'local-token'   # 非回环地址必须设置
```

`config/cc-switch-mcp.example.json` 是无密钥的模板。CC-switch 的 `server_config` 使用标准 `mcpServers` 结构，支持 `stdio` 与 `http`。

## 数据库与验证

设置 `HETEMCP_DATABASE_URL` 后，服务自动执行幂等 migration，Worker Loop 回收过期 lease 并消费队列。数据库保存任务与产物引用，产物文件需另外备份。

```powershell
npm run test:integration:docker
```

该命令运行真实 PostgreSQL 并发、恢复和 migration 测试，并清理测试容器与数据卷。`npm run db:up` / `npm run db:down` 用于本地测试容器；仓库 Compose 使用 **tmpfs 临时数据库**，不能作为持久化部署模板。已有持久化实例应单独管理，勿用测试清理命令管理其数据。

## 文件、归档与私有痕迹

GitHub 只保留源码、测试、可复现配置、示例及维护中的文档。以下内容不上传：

- `.heteromcp/`（artifacts、runs、DSH home、归档、私有实验目录、CC-switch 导入文件）。
- `docs/mla-*`、`docs/nsa-*`、`skill/MLA_skill.md`、`skill/NSA_skill.md` 等私有负载路径。
- `node_modules/`、`dist/`、凭据、日志和中间二进制。
- `package-lock.json` 和已验收的 `test/bubble.cpp` 仍保留。

```powershell
npm run check:private       # 任何被 Git 跟踪的私有痕迹路径都会失败
npm run hooks:install       # 启用 githooks/pre-push，在推送前再检查一次
npm run private:inventory   # 生成本地 .heteromcp/PRIVATE-WORK.md 与 manifest
```

私有实验目录保留原路径，不自动搬迁：既有任务记录、脚本和归档可能引用当前位置。Git push 不能替代本地备份；归档与备份规则见 [文件管理约定](docs/repository-layout.md)。
