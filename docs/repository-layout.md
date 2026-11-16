# 仓库文件、归档与发布约定

本约定区分维护中的工程资产、可复现实例和本地执行材料。归档保留证据，不表示仍然推荐历史参数或继续执行历史任务。

## 文件归属

| 路径                                                      | 内容                                                   | GitHub                 |
| --------------------------------------------------------- | ------------------------------------------------------ | ---------------------- |
| `src/`                                                    | 领域协议、编排器、模式路由、adapter、MCP transport     | 保留                   |
| `tests/`                                                  | 自动化单元、契约、集成测试                             | 保留                   |
| `test/bubble.cpp`                                         | 已验收的 DSH 原始示例产物；区别于 `tests/` 测试套件    | 保留                   |
| `scripts/`                                                | 调度、验收、数据库测试、CC-switch 导出与痕迹守卫工具   | 保留                   |
| `githooks/`                                               | `pre-push` 私有痕迹守卫                                | 保留                   |
| `config/`                                                 | 无密钥任务示例、CC-switch 模板和版本固定的 DSH overlay | 保留                   |
| `docs/`、`skill/heteromcp-context-governance/`            | 当前操作说明、架构与可复用治理规则                     | 保留                   |
| `package-lock.json`、`.env.example`                       | 依赖锁定与脱敏配置示例                                 | 保留                   |
| `.heteromcp/artifacts/<task>/<attempt>/`                  | workspace、源码、报告、review JSON 和验收产物          | 忽略，按任务备份       |
| `.heteromcp/runs/`                                        | 调度端任务记录快照，可能含完整 objective               | 忽略，按任务备份       |
| `.heteromcp/dsh-home/`                                    | Harness 私有会话与运行时配置                           | 忽略，限制访问         |
| `.heteromcp/archive/`                                     | 历史实验记录、任务专用交接与归档清单                   | 忽略，本地归档         |
| `.heteromcp/cc-switch/`                                   | `npm run mcp:cc-switch` 生成的导入配置                 | 忽略，本机导入         |
| `.heteromcp/` 下临时脚本、profile、依赖                   | 一次性探索和中间结果                                   | 忽略，确认引用后再清理 |
| `node_modules/`、`dist/`、`coverage/`、缓存、日志、二进制 | 可再生产物                                             | 忽略                   |
| `.env`、credentials 文件                                  | 本地配置和密钥                                         | 忽略；只提交脱敏示例   |

自定义 `HETEMCP_ARTIFACT_ROOT` 不会自动修改 Git 规则；优先放在仓库外或 `.heteromcp/` 内。归档不能替代脱敏，归档也不能用于规避对维护文件的格式检查。

## 私有实验痕迹

项目外的模型/硬件/评分实验、任务专用 Skill、交接和原始日志属于私有工作痕迹。它们统一放在被忽略的 `.heteromcp/` 下，或使用 `.gitignore` 中的私有负载模式；不得进入公开文档、通用 Skill、示例配置或 Git 历史。

- `npm run check:private` 扫描 `git ls-files`，任何被跟踪的 `.heteromcp/`、私有负载目录或 `mla`/`nsa` 路径都会使检查失败。
- `npm run hooks:install` 将 `core.hooksPath` 指向仓库内的 `githooks/`；`pre-push` 会再次运行同一守卫，防止 `git add -f` 绕过忽略规则。
- `npm run private:inventory` 生成本地 `.heteromcp/PRIVATE-WORK.md` 和 `private-work-manifest.json`，只记录路径、文件数和字节数，不复制内容。
- 归档时记录原路径、原因、task/attempt/session 标识（适用时）、产物哈希、已验证与未验证范围。完整输出保存在本地引用处，公共文档只保留必要摘要。
- 活动实验目录默认保持原路径：既有任务记录、脚本和归档可能引用当前位置。再次整理时先查引用，不能仅凭“临时”文件名判断可移动或可删除。
- 清理可再生产物前确认无活动进程及保留需求；删除仍被任务引用的源码或报告前先备份并处理引用。本仓库不执行自动保留期删除。
- Git push 只保存 Git 跟踪资产，不能替代数据库、artifact、归档或会话备份。

## 新材料与清理

- 可复用的操作步骤和稳定结论更新到维护文档；去掉账号、主机、凭据、完整 prompt 和原始会话。
- 一次性任务 JSON、下载、远程运行结果和试验脚本直接放入 `.heteromcp/` 的任务目录；任务专用交接放本地归档，不加入通用 Skill。
- 公共文档不写本机绝对路径、私有主机、历史评分或实验专用 Skill 的内容。

## 发布与备份

提交前检查 `git status --short`、`git diff --stat`、未跟踪文件和 `git check-ignore -v <path>`。`.gitignore` 对已跟踪文件不生效，不能依赖它清除已提交的敏感内容；需要移除时使用 `git rm --cached` 并确认历史是否已推送。

运行 `npm run check` 和 `npm run build`。数据库变更还应运行真实 PostgreSQL 契约/集成验证；真实 Claude/Codex/DSH 调用属于显式启用的外部验证，不是默认测试的一部分。

任务数据库、artifact 文件与运行快照应作为相互关联的数据备份；单独备份数据库不会保存 `file:` URI 指向的内容。恢复后核对引用路径和 SHA-256。会话、原始任务和本地归档可能含私有信息，备份同样需限制访问。
