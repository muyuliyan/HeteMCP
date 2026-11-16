[Chinese](README.md) · **English**

# HeteMCP

HeteMCP is a provider-neutral MCP orchestration service for personal multi-model workflows. It dispatches **Claude Code**, **Codex**, **DeepSeek Harness (DSH)**, or a deterministic fake under one task contract, and provides three execution modes: **dispatch**, **mutual-check**, and **workflow** (`workflaw` is a compatible alias).

- [Architecture and engineering rules](docs/architecture.md) (implementation source of truth)
- [Architecture in Chinese](docs/architecture.zh-CN.md)
- [Context governance and handoff Skill](skill/heteromcp-context-governance/SKILL.md)
- [DSH configuration, reproduction, and verification](docs/deepseek-smoke.md)
- [Repository layout, archives, and delivery rules](docs/repository-layout.md)

## Current capabilities and boundaries

```text
Claude Code / Codex / MCP client
  -> MCP stdio or Streamable HTTP
  -> Orchestrator -> ModeRoutingExecutor
  -> dispatch:      Claude / Codex / DSH / fake -> isolated workspace -> file scope check + SHA-256
  -> mutual-check:  selected reviewers inspect independently -> cross-review -> checks + reviews
  -> workflow:      dispatch, then mutual-check automatically
  -> result -> supervisor compilation / behavior acceptance -> explicit publication
```

- Strict TypeScript/Zod contracts, idempotent creation, execution deduplication, timeout, cancellation, and an acceptance state machine.
- In-memory and PostgreSQL repositories, revision checks, atomic claims, heartbeats, expired-lease recovery, and stale-result rejection.
- All three modes share one task contract. The default is always `dispatch`; there is no silent fallback to fake or another agent.
- The manager can call `plan_work` for a deterministic `WorkPacketV1`, then `execute_work_packet` to dispatch according to it; packets carry roles, phases, a task template, `planHash`, stop conditions, and a retry limit.
- `deepseek-file-generation`, `claude-file-generation`, `codex-file-generation`, and the generic `file-generation` profile generate exactly one plain `.cpp`, `.txt`, or `.md` file, non-empty and at most 128 KiB, and store SHA-256 hashes of the source and report.
- `mutual-check` uses 1–8 selected reviewers over file artifacts. With two or more reviewers, each reviewer sees the other reviewers' conclusions and issues a final verdict. All final verdicts must pass.
- `workflow` dispatches first and then runs mutual-check; `workflaw` is a compatible alias.
- MCP is available over stdio or a local Streamable HTTP port; CC-switch can import the generated `mcpServers` configuration directly.
- `succeeded` proves only that the declared acceptance passed. File-generation mode does not include compilation, numerical correctness, or performance acceptance; the supervisor still owns those checks.

The service does not currently provide general repository modification, automatic merging, enforced token/cost budgets, or an MCP progress stream. Mutual-check is model review evidence, not compilation or runtime proof; deterministic aggregation only guarantees that every reviewer's final verdict passed.

## Modes and workers

| Mode               | `mode`                  | Behavior                                                                                                                                |
| ------------------ | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Dispatch (default) | `dispatch`              | One worker generates a file; acceptance must include `generated-file-scope`                                                             |
| Mutual-check       | `mutual-check`          | Independent review and cross-review of an existing task's artifacts; requires `sourceTaskId`; acceptance must be exactly `mutual-check` |
| Workflow           | `workflow` / `workflaw` | Dispatch, then mutual-check; acceptance must contain `generated-file-scope` and `mutual-check`, and no other names                      |

A task selects concrete models through `worker` / `reviewers`:

```json
{
  "workerProfile": "file-generation",
  "worker": { "agent": "claude", "model": "sonnet" },
  "mode": "workflow",
  "reviewers": [{ "agent": "codex" }, { "agent": "claude", "model": "opus" }]
}
```

To run mutual-check separately after a dispatch, call the convenience tool directly:

```json
{
  "idempotencyKey": "review-1",
  "sourceTaskId": "00000000-0000-4000-8000-000000000000",
  "reviewers": [{ "agent": "claude" }, { "agent": "codex", "model": "gpt-5" }]
}
```

- `workerProfile` may be `file-generation` (together with `worker` or `HETEMCP_DEFAULT_WORKER`), `claude-file-generation`, `codex-file-generation`, `deepseek-file-generation`, or `fake`.
- Standalone mutual-check tasks use `workerProfile: "mutual-check"`, `mode: "mutual-check"`, and `sourceTaskId`.
- Agent names are determined by `HETEMCP_AGENTS` and auto-discovery; `model` is passed to the corresponding CLI (`--model` for Claude and Codex).
- Unavailable agents appear in `list_workers` with a reason. Selecting one fails explicitly and never falls back to fake.

## Work packets and dispatch policy

Managed work no longer asks the manager to choose a mode. The recommended flow is:

```text
manager -> plan_work -> work packet -> write design -> execute_work_packet -> worker -> get_task_result -> manager verification
```

`plan_work` uses `taskKind`, `risk`, `ambiguity`, independent-verification requirements, an existing artifact, an explicit mode, `reviewBy`, and available agents to return a deterministic `WorkPacketV1`. Decision order:

| Order | Condition                                           | Strategy                                                                                            | Effective task mode |
| ----- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------- |
| 1     | Existing `sourceTaskId`, or a review task           | `review-only`                                                                                       | `mutual-check`      |
| 2     | Explicit mode requested                             | Validate and honor; conflicting requests become `blocked`                                           | Requested mode      |
| 3     | High risk or independent verification required      | Reviewer available → `cross-check`; else manager can verify → `supervised`; else `blocked`          | workflow / dispatch |
| 4     | Medium risk, medium ambiguity, or code work         | Manager can design + verify → `supervised`; else reviewer available → `cross-check`; else `blocked` | dispatch / workflow |
| 5     | Low risk, one artifact, no independent verification | `dispatch`                                                                                          | dispatch            |
| 6     | No usable worker/reviewer                           | `blocked` with a reason                                                                             | None                |

The default worker priority is `deepseek > codex > claude`. An explicitly preferred worker that is unavailable produces `blocked`; the planner never silently switches agents.

`reviewBy` selects the verifier:

- `manager` (recommended default): the manager writes the design and performs final verification; the worker only executes.
- `harness`: MCP runs the selected reviewers for internal cross-check; the manager still performs final verification.
- `auto`: explicit `preferredReviewers` use harness cross-check; otherwise workflow defaults to manager verification.

### Bubble sort example

The manager requests a packet first; see [work-packet-request.json](config/work-packet-request.json):

```json
{
  "instruction": "Write a bubble sort program using workflow mode",
  "taskKind": "code",
  "artifactName": "bubble.cpp",
  "requestedMode": "workflow",
  "reviewBy": "manager",
  "preferredWorker": "deepseek"
}
```

`preferredWorker: "deepseek"` requires a configured DSH; otherwise `plan_work` returns `blocked` instead of switching agents. Omit `preferredWorker` to use the first available local agent.

The returned packet contains:

- `strategy: supervised`
- `worker: deepseek`
- `verifier: manager`
- `phases: design -> dispatch -> verify`
- `taskMode: dispatch`
- `taskTemplate.acceptance: ["generated-file-scope"]`
- `planHash`, stop conditions, and the retry limit

The manager then:

1. Writes a concise design covering inputs, outputs, edge cases, interfaces, and verification.
2. Calls `execute_work_packet` with the unchanged packet, the `design`, and a new `idempotencyKey`.
3. MCP merges the design into the worker context and dispatches to DeepSeek Harness to generate `bubble.cpp`.
4. Polls `get_task_result`, compiles independently, and runs bubble-sort behavior tests.
5. Delivers on success; on failure, calls `plan_work` again with the failure evidence and respects the packet's retry limit.

To ask Codex to cross-check instead:

```json
{
  "requestedMode": "workflow",
  "reviewBy": "harness",
  "preferredReviewers": ["codex"]
}
```

The packet becomes `cross-check` with `taskMode: workflow`; MCP runs Codex as a reviewer, and the manager still performs final verification.

`plan_work` and `execute_work_packet` are the recommended managed-work entry points. `create_task`, `create_workflow`, and `create_mutual_check` remain available for advanced or direct use.

## Development and operation

Node.js 22+ is required. Run from the repository root:

```powershell
npm ci
npm run check
npm run build
npm start
```

`npm run check` runs type checking, ESLint, Prettier, the private-trace guard, and fast tests (including the PGlite repository contract suite). Use `npm run dev` for development. The MCP client command is `node <absolute-repository-path>/dist/index.js`; the service now resolves the repository root from its module location, so the client cwd no longer has to be the repository root. stdout is reserved for the protocol and startup diagnostics go to stderr.

## Agent configuration

`HETEMCP_AGENTS=auto` (the default) auto-detects:

- **Claude Code**: `claude.exe` on `PATH`, or `~/.local/bin/claude.exe`; override with `HETEMCP_CLAUDE_EXECUTABLE`.
- **Codex**: `%LOCALAPPDATA%/OpenAI/Codex/bin/*/codex.exe`, or `codex.exe` on `PATH`; override with `HETEMCP_CODEX_EXECUTABLE`.
- **DSH**: enabled only when `HETEMCP_DSH_DESKTOP`, `HETEMCP_CREDENTIALS_PATH`, and `HETEMCP_ALLOW_UNMETERED=1` are set.

Both workers isolate user MCP configuration (Claude `--strict-mcp-config`, Codex `-c mcp_servers={}`) so a worker cannot call HeteMCP back.

```powershell
$env:HETEMCP_AGENTS = 'auto'
$env:HETEMCP_CLAUDE_MODEL = 'sonnet'
$env:HETEMCP_CODEX_MODEL = 'gpt-5'
npm start
```

See the [DSH operation guide](docs/deepseek-smoke.md) for full DSH configuration, reproduction, and verification steps. The service does not automatically load `.env`; configuration must reach the actual service process environment. `scripts/run-file-task.ts` explicitly forwards these variables.

| Environment variable                 | Behavior                                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------- |
| `HETEMCP_AGENTS`                     | `auto` (default) or a comma-separated `claude,codex,deepseek,fake` list                     |
| `HETEMCP_DEFAULT_WORKER`             | Agent used when `workerProfile: file-generation` omits `worker`                             |
| `HETEMCP_CLAUDE_EXECUTABLE`          | Absolute Claude Code CLI path; must be a native `.exe`                                      |
| `HETEMCP_CLAUDE_MODEL`               | Default Claude model                                                                        |
| `HETEMCP_CODEX_EXECUTABLE`           | Absolute Codex CLI path; must be a native `.exe`                                            |
| `HETEMCP_CODEX_MODEL`                | Default Codex model                                                                         |
| `HETEMCP_DSH_DESKTOP`                | Enables the Desktop-compatible DSH executor; credentials and unmetered opt-in are required  |
| `HETEMCP_CREDENTIALS_PATH`           | File path read by the native credentials plugin                                             |
| `HETEMCP_ALLOW_UNMETERED=1`          | Explicitly accepts unmetered mode; `usage.measured=false` means unknown, not free           |
| `HETEMCP_DATABASE_URL`               | Selects PostgreSQL when set; otherwise tasks exist only in the current process memory       |
| `HETEMCP_ARTIFACT_ROOT`              | Optional source/report directory, default `.heteromcp/artifacts`; relative to the repo root |
| `HETEMCP_ALLOW_EXTERNAL_ARTIFACTS=1` | Allows mutual-check to read `file:` artifacts outside the artifact root (denied by default) |

## MCP tools

| Tool                  | Arguments                                                                                                                      | Purpose                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `plan_work`           | `{instruction, taskKind?, risk?, ambiguity?, requestedMode?, reviewBy?, preferredWorker?, preferredReviewers?, sourceTaskId?}` | Return a deterministic work packet                            |
| `execute_work_packet` | `{packet, design?, idempotencyKey}`                                                                                            | Validate a packet and create its task                         |
| `create_task`         | `{idempotencyKey, task}`                                                                                                       | Advanced: create a task directly from `task.mode`             |
| `create_workflow`     | `{idempotencyKey, task, reviewers}`                                                                                            | Convenience dispatch + mutual-check task; adds `mutual-check` |
| `create_mutual_check` | `{idempotencyKey, sourceTaskId, reviewers, objective?, timeoutMs?}`                                                            | Create a mutual-check task for an existing task's artifacts   |
| `list_workers`        | `{}`                                                                                                                           | List execution modes and agent availability                   |
| `get_task`            | `{taskId}`                                                                                                                     | Read status, attempt, lease, and any existing result          |
| `cancel_task`         | `{taskId}`                                                                                                                     | Request cancellation                                          |
| `get_task_result`     | `{taskId}`                                                                                                                     | Return the full record, checks, reviews, and artifacts        |

Successful task responses are under `structuredContent.task` (`list_workers` uses `structuredContent.catalog`); check `isError` first. The task contract lives in [schemas.ts](src/domain/schemas.ts), and a workflow example is in [workflow-task.json](config/workflow-task.json). Reuse the idempotency key when retransmitting the same submission; use a new key for an intentional new execution.

Mutual-check artifacts and review JSON files are stored under `.heteromcp/artifacts/<task>/<attempt>/reviews/`. Reviewers can modify only their own working copies; code verifies that candidate file hashes were not changed.

## Example run

```powershell
npm run build
node node_modules/tsx/dist/cli.mjs scripts/run-file-task.ts config/workflow-task.json
```

The script calls the service over real MCP stdio, polls until a terminal state, and saves the complete record to `.heteromcp/runs/<task-id>.json`; it does not publish generated files automatically.

## CC-switch and HTTP MCP

Generate configuration that CC-switch can import directly:

```powershell
npm run build
npm run mcp:cc-switch
```

Outputs are written under `.heteromcp/cc-switch/`:

- `heteromcp.stdio.json`: stdio entry with the local node, absolute repository path, and discovered agent paths.
- `heteromcp.http.json`: local Streamable HTTP entry.
- `heteromcp.mcp.json`: both entries combined.

Import the appropriate file on the CC-switch MCP page. The HTTP entry requires the service to be running first:

```powershell
npm run start:http
```

The default endpoint is `http://127.0.0.1:8787/mcp`, with a health check at `http://127.0.0.1:8787/healthz`. Adjust it through environment variables or CLI flags:

```powershell
node dist/index.js --transport http --host 127.0.0.1 --port 8787 --path /mcp
$env:HETEMCP_MCP_TOKEN = 'local-token'   # required for non-loopback binds
```

`config/cc-switch-mcp.example.json` is a secret-free template. CC-switch's `server_config` uses the standard `mcpServers` shape and supports both `stdio` and `http`.

## Database and verification

When `HETEMCP_DATABASE_URL` is set, the service applies idempotent migrations automatically, and the worker loop recovers expired leases and drains the queue. The database stores task state and artifact references; artifact files need a separate backup.

```powershell
npm run test:integration:docker
```

This command runs real PostgreSQL concurrency, recovery, and migration tests, then cleans up test containers and volumes. `npm run db:up` / `npm run db:down` manage local test containers; the repository Compose file uses a **tmpfs temporary database** and is not a durable deployment template. Manage an existing persistent instance separately and do not use the test cleanup commands on its data.

## Files, archives, and private traces

GitHub keeps only source, tests, reproducible configuration, examples, and maintained documentation. The following are not uploaded:

- `.heteromcp/` (artifacts, runs, DSH home, archives, private experiment directories, and CC-switch import files).
- Private workload paths such as `docs/mla-*`, `docs/nsa-*`, `skill/MLA_skill.md`, and `skill/NSA_skill.md`.
- `node_modules/`, `dist/`, credentials, logs, and intermediate binaries.
- `package-lock.json` and the accepted `test/bubble.cpp` example are retained.

```powershell
npm run check:private       # fails if any private trace path is tracked by Git
npm run hooks:install       # configures githooks/pre-push for a second check before pushing
npm run private:inventory   # writes local .heteromcp/PRIVATE-WORK.md and a manifest
```

Live experiment directories keep their original paths and are not moved automatically: existing task records, scripts, and archives may reference their current locations. Git push is not a backup. See [repository layout and retention](docs/repository-layout.md) for archive and backup rules.
