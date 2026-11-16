# HeteMCP Architecture

> English source of truth for implementation. See [architecture.zh-CN.md](architecture.zh-CN.md) for the Chinese companion.

## 1. Purpose and Scope

HeteMCP is a provider-neutral orchestration service for heterogeneous model workers. A capable coordinator plans, routes, reviews, and escalates work; lower-cost models execute bounded tasks; Codex or another MCP client is the operator interface.

The target path is:

`MCP client -> MCP gateway -> orchestrator -> mode router -> agent harness -> artifacts -> optional mutual check -> result`

The MVP prioritizes recoverable execution, explicit state, enforceable permissions, and verifiable output. Three modes share one task contract: `dispatch` (default), `mutual-check`, and `workflow` (dispatch then mutual check; `workflaw` is an input alias). It does not attempt autonomous agent organizations, general workflow DSLs, or distributed infrastructure without measured need.

## 2. Architectural Invariants

- **Deterministic control plane:** models propose actions; code enforces state transitions, leases, budgets, permissions, retries, and acceptance.
- **Provider isolation:** domain and orchestration code depend only on internal ports. Provider SDK details stay in adapters.
- **Artifact-backed completion:** a model response is not proof. Success requires acceptance evidence and durable artifacts.
- **Recoverable execution:** every attempt has an identity and a bounded lease. A stale attempt cannot overwrite a newer owner.
- **Context is not authority:** summaries and handoffs preserve decisions and evidence but never expand tool or filesystem permissions.
- **Modular monolith first:** boundaries are in-process interfaces until throughput or reliability data justifies another service.
- **Explicit failure:** no unbounded retry, silent fallback, or partial success reported as completion.

## 3. Component Boundaries

| Component        | Owns                                                              | Must not own                                |
| ---------------- | ----------------------------------------------------------------- | ------------------------------------------- |
| MCP Gateway      | Tool schemas and transport                                        | Routing or task-state decisions             |
| Orchestrator     | State machine, timeout, cancellation, acceptance, lease ownership | Provider SDK details                        |
| Worker Loop      | Recovery and queue draining                                       | Domain policy                               |
| Mode Router      | Mode selection, agent resolution, workflow composition            | Permission bypass or silent fallback        |
| Provider Adapter | Model request/response, streaming, usage, error mapping           | Task persistence                            |
| Worker Runtime   | Isolated tools, repository changes, artifact production           | Unrestricted host access                    |
| Evaluator        | Tests, policy checks, deterministic acceptance, mutual review     | Treating subjective review as compile proof |
| Task Repository  | Atomic claim, revision checks, lease persistence                  | Business-state decisions                    |
| Artifact Store   | Patches, logs, reports, hashes, retention                         | Large blobs embedded in task rows           |
| Event/Telemetry  | Traceable lifecycle events, metrics, cost                         | Secrets or unrestricted prompt content      |

Dependency direction is `transport -> application -> domain`; provider, database, and worker implementations live under infrastructure.

## 4. Core Contracts

All boundary data is versioned and validated on entry. IDs are unguessable, timestamps use UTC ISO 8601, tokens are integers, and money uses integer micro-units.

### Task lifecycle

`queued -> running -> reviewing -> succeeded | failed`

Additional transitions support `blocked`, `cancelled`, and `running -> queued` after lease expiry. Only the Orchestrator decides business transitions; repositories apply atomic persistence operations.

### TaskSpecV1

Carries one verifiable objective, allowed and excluded paths, acceptance requirements, worker profile, token/cost limits, timeout, and a `ContextEnvelopeV1`. Additive V1 fields select the execution mode and participants:

- `mode`: `dispatch` (default), `mutual-check`, or `workflow`; `mutual_check`, `cross-check`, and `workflaw` are accepted input aliases but normalized before persistence.
- `worker`: optional `{ agent, model? }`; its presence takes precedence over profile-derived routing.
- `reviewers`: `{ agent, model? }[]`, up to eight, required for mutual-check and workflow.
- `sourceTaskId`: required for standalone mutual-check, rejected for dispatch and workflow.

Workflow dispatches with the same spec minus `mutual-check` acceptance, then reviews the dispatch artifacts. Mutual-check requires `mutual-check` acceptance; only implemented acceptance names are allowed, and every reviewer's final verdict must pass.

### AttemptResultV1

Carries status, summary, artifact references, named check results, optional structured `reviews`, usage, and an optional typed error. A successful result must include an artifact and a passed check for every acceptance requirement. Mutual-check runs emit one check per reviewer plus an aggregate `mutual-check` check; model verdicts are evidence, not compilation or runtime proof.

### ContextEnvelopeV1

Carries only the current summary, decisions with reasons, traceable evidence, and unresolved questions. Large raw output belongs in the artifact store and is referenced rather than copied.

### WorkPacketV1

The manager supplies task signals, not a mode choice. `plan_work` returns a deterministic packet containing:

- `decision`: strategy (`dispatch`, `supervised`, `cross-check`, `review-only`, `blocked`), effective `taskMode`, matched rule, confidence, and score/factors;
- `roles`: planner, worker, reviewers, verifier;
- `phases`: design, dispatch, verify, replan/unblock with required flags;
- `taskTemplate`: a TaskSpecV1 using `dispatch` (dispatch/supervised), `workflow` (cross-check), or `mutual-check` (review-only);
- `managerInstructions`, `stopConditions`, and `escalation`;
- `planHash`: canonical SHA-256 over the packet without the hash.

`execute_work_packet` verifies the hash, rejects tampered or blocked packets, requires a manager design when the design phase is required, and merges that design into the worker context. The policy order is: existing artifact → review-only; explicit mode → honor or block on conflict; high risk or independent verification → cross-check when reviewers exist, otherwise supervised manager verification, otherwise blocked; medium risk, medium ambiguity, or code → supervised, cross-check, or blocked; low risk → dispatch; no worker/reviewer → blocked. Default worker priority is `deepseek > codex > claude`; an unavailable explicit worker blocks instead of silently switching.

## 5. Implemented Baseline

The current supported path is supervised single-file generation with optional peer review:

`Claude Code / Codex / MCP client -> MCP stdio or Streamable HTTP -> Orchestrator -> ModeRouter -> AgentHarness (Claude/Codex/DSH/fake) -> scope checks/artifacts -> optional mutual check -> result -> supervisor acceptance/publication`

Claude Code and Codex are both execution adapters and MCP clients. `TaskExecutor` is the application execution port; `ModelProvider` remains a compatibility alias. `AgentHarness` reports process/session outcomes, not authoritative task acceptance. `ModeRoutingExecutor` composes dispatch, mutual-check and workflow without letting a model claim acceptance. The general worker runtime, durable artifact service and broad evaluator in section 3 remain target boundaries.

Implemented capabilities:

- strict TypeScript/Zod task, context, artifact, check, review, usage and result contracts;
- idempotent creation, execution deduplication, timeout, cancellation and acceptance state transitions;
- MCP tools `plan_work`, `execute_work_packet`, `create_task`, `create_workflow`, `create_mutual_check`, `list_workers`, `get_task`, `cancel_task`, `get_task_result`;
- a deterministic work planner that selects dispatch, supervised, cross-check, review-only, or blocked strategies and emits hashed packets with roles, phases, task templates, and stop conditions;
- a local Streamable HTTP endpoint with session management, optional bearer token, loopback binding and health check;
- in-memory/PostgreSQL repositories, revision checks, atomic claims (`FOR UPDATE SKIP LOCKED`), heartbeat renewal, lease recovery and stale-result rejection;
- a recovery/queue worker loop and transactionally serialized, idempotent migrations;
- auto-detected Claude Code and Codex harnesses, opt-in DSH Desktop `0.2.1-rc.2`, and deterministic fake execution;
- shell-free subprocess execution, bounded diagnostics, typed completion and process-tree cancellation for all three harnesses;
- per-attempt empty workspaces, independent file scope inspection, SHA-256 source/report references;
- mutual-check with isolated reviewer workspaces, candidate hash checks, optional cross-review round and deterministic aggregation;
- a real MCP client script and a separate C++ compiler/behavior verifier with explicit publication;
- automated domain, orchestration, process/protocol, file-scope, mode-routing, HTTP, transport and shared repository contract tests; a separate real PostgreSQL integration suite.

Verification commands are `npm run check` and `npm run build`; use `npm run test:integration:docker` for real PostgreSQL. Test counts and dependency audit results are time-specific evidence, not permanent architectural guarantees. Real DSH evidence is recorded in [deepseek-smoke.md](deepseek-smoke.md); simulated harness tests do not establish real model connectivity for Claude or Codex.

## 6. Runtime and Persistence Decisions

### Configuration and client supervision

The server resolves policy and private runtime paths from its module location, so clients do not need a repository-root cwd. MCP uses `node <absolute-repository-path>/dist/index.js`; stdout is protocol-only. Claude Code, Codex or another MCP client supplies the actual service environment. The service does not automatically load `.env`.

`HETEMCP_AGENTS=auto` detects Claude Code, Codex and a configured DSH install; an explicit comma list narrows the set. Claude and Codex require native executables (`.exe` on Windows), never `.cmd` shims or shell interpolation. Claude workers run with `--strict-mcp-config` and Codex workers pass `-c mcp_servers={}` so user MCP servers are not exposed to a worker. `HETEMCP_CLAUDE_MODEL` and `HETEMCP_CODEX_MODEL` provide defaults; a task `worker.model` or reviewer `model` overrides them. DSH requires `HETEMCP_DSH_DESKTOP`, `HETEMCP_CREDENTIALS_PATH` and explicit `HETEMCP_ALLOW_UNMETERED=1`. `HETEMCP_DATABASE_URL` independently selects PostgreSQL; otherwise records are process-local. `scripts/run-file-task.ts` explicitly forwards these variables plus optional `HETEMCP_ARTIFACT_ROOT` to its MCP subprocess. Merely setting a parent variable is insufficient if a custom client omits it from its transport environment.

All task tools return the complete record at `structuredContent.task` on success; `list_workers` returns `structuredContent.catalog`. Check `isError` before reading either. `get_task_result` does not perform compilation or wait for completion. The example client polls with a supervisor deadline and requests cancellation on expiry. It generates a new idempotency key per invocation; clients retrying the same submission must reuse their key.

### Modes and mutual check

- Managed clients call `plan_work` first and follow the returned packet; `create_task` remains an advanced direct interface. The planner is deterministic code, not a model call.
- **Dispatch** is the default. The router resolves `worker` or derives an agent from `workerProfile`; missing or mismatched agents fail explicitly.
- **Mutual-check** requires `sourceTaskId` plus at least one reviewer. Reviewers receive fresh workspaces containing copies of the source artifact, never the original workspace. With two or more reviewers, round 2 exposes each reviewer to peers' round-1 findings; the final verdict is the round-2 verdict. Every round verifies candidate hashes; a modified candidate fails that reviewer.
- **Workflow** runs dispatch first with `mutual-check` removed from the dispatch acceptance set, then runs mutual-check over the dispatch artifacts. A failed dispatch skips review and records a skipped aggregate check. `workflaw` is an accepted input alias normalized to `workflow`.
- Reviewer output must be a single bounded `review.json` matching the versioned schema. Invalid output is a failed review, not a crash. Review artifacts are hashed and stored under the attempt directory.
- Mutual check is advisory evidence from models. It never replaces compilation, behavior tests, measured usage or supervisor publication.

### MCP HTTP and CC-switch

`--transport http` or `HETEMCP_MCP_TRANSPORT=http` starts a Streamable HTTP endpoint (default `127.0.0.1:8787/mcp`) with per-session servers, JSON responses, `/healthz`, a session cap and loopback origin checks. A non-loopback bind requires `HETEMCP_MCP_TOKEN`; tokens are compared in constant time. `npm run mcp:cc-switch` writes ready-to-import `mcpServers` files under ignored `.heteromcp/cc-switch/` with absolute node, repository, agent and artifact paths. CC-switch can import the stdio entry directly; the HTTP entry requires `npm run start:http`.

### DSH Desktop compatibility

The pinned desktop adapter launches `DeepSeek Harness.exe` as Node (`ELECTRON_RUN_AS_NODE=1`) with its bundled `resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js`. Use absolute executable/entrypoint paths, stdin prompts and explicit environment; no npm `.cmd` shim or shell interpolation.

Desktop `0.2.1-rc.2` does not support the modern `--permission-mode` interface. Its explicit legacy mode uses `--profile headless --patch ...` and [the audited overlay](../config/deepseek-desktop-0.2.1.patch.yml): workspace-write, approval never, native credentials by path, `deepseek-official/deepseek-flash`, shell/web/delegation/plugin-management tools disabled. It uses private `.heteromcp/dsh-home`, leaving the personal profile unchanged. Credentials are loaded by the native plugin, never embedded in tasks.

Legacy completion requires the initial session, a valid legacy final and exit zero, based on inspected runner semantics. Modern mode additionally requires the completed final reason and matching session identity. Never select legacy mode automatically because output is malformed. Recheck CLI, protocol and policy before supporting another version; a successful help invocation is insufficient. No automatic model-call retry or broader permission fallback is implemented.

### File generation and acceptance

The file-generation executor accepts the generic `file-generation` profile (with an explicit worker or `HETEMCP_DEFAULT_WORKER`) or the agent-specific `claude-file-generation`, `codex-file-generation` and legacy `deepseek-file-generation` profiles. It requires one plain filename matching `.cpp`, `.txt` or `.md`, no excluded paths and `generated-file-scope` in acceptance. Each attempt creates a fresh empty directory rather than exposing the checkout. It independently verifies exactly one nonempty regular file, at most 128 KiB, and stores SHA-256 references to source and report. The executor checks that an explicit `worker.agent` matches the selected harness.

`HarnessOutcome.completed` proves a completed turn. Task `succeeded` in this profile proves that turn plus scope validation and, in workflow mode, all reviewer verdicts. None of these prove compilation, behavior, numerical correctness or performance. Independent supervisor checks precede explicit publication; preserve worker bytes when coding is assigned exclusively to a model. `scripts/verify-bubble.ts` verifies the source hash, compiles/tests and only publishes with `--publish`, refusing a nonempty destination.

Token/cost ceilings in V1 are advisory for this profile. `usage.measured=false` with zero counters means unknown, not free. Explicit unmetered opt-in is required for DSH; the wall-clock timeout is enforced for every harness. Generic acceptance-command execution, enforceable resource ceilings and repository patch validation remain future work.

### PostgreSQL and artifact retention

| Concern            | Decision                                                                                                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fast feedback      | PGlite runs the shared repository contract suite without Docker.                                                                                                                                                                            |
| Real database      | PostgreSQL 17 integration tests cover independent claims, connection loss/restart, heartbeat, concurrent migrations and index plans.                                                                                                        |
| Migration safety   | A transaction-scoped advisory lock serializes metadata creation and migration versions.                                                                                                                                                     |
| Local Compose      | `compose.yaml` uses tmpfs and test-only credentials. `db:up`/`db:down` are disposable development operations, not durable deployment or backup. The integration runner removes its test containers/volumes.                                 |
| Durable deployment | Supply an independently managed database via `HETEMCP_DATABASE_URL`; manage its storage, secrets and backups separately from disposable tests.                                                                                              |
| Artifacts          | Database rows retain task state and artifact references. Files remain under `.heteromcp/artifacts/<task>/<attempt>/` by default; the client saves snapshots in `.heteromcp/runs/`. Database persistence alone does not back up those files. |

Worker recovery concerns expired leases and stale owners; no exactly-once external execution guarantee is claimed. Do not relocate/delete referenced artifacts or session directories during housekeeping. Back up records and files together and verify URI resolution and hashes after restoration.

## 7. Remaining Work

| Capability            | Remaining scope                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| General worker        | Repository worktrees/containers, runtime path/command policy, resource bounds, cleanup and patch collection                                |
| Acceptance            | Versioned structured commands, general build/test evaluator and patch-scope validation                                                     |
| Artifact service      | Portable durable storage, access control, retention and backup/restore tooling beyond local hashed files                                   |
| Provider inference    | OpenAI-compatible inference adapter, streaming, measured usage and normalized errors; Claude, Codex and DSH agent execution are integrated |
| Budgets/retries       | Enforced token/cost ceilings, bounded retry/backoff and deadline/attempt policy                                                            |
| MCP interaction       | Bounded server-side waiting and cursor-based progress; the current client polls                                                            |
| Routing/task graphs   | Work-packet mode/agent routing is implemented; measured cost/latency policy, fallback, dependencies and decomposition remain pending       |
| Context/observability | Automated compression/handoff validation, lifecycle event store, traces, metrics and cost accounting                                       |
| Service security      | Authentication, tenant isolation, secret management and production retention controls                                                      |

Implement a versioned contract when acceptance or workspace semantics change; preserve stored V1 records. A Git worktree isolates edits but is not a host filesystem sandbox. The current file-generation profile is a supported bounded workflow, not a general production worker.

## 8. Repository and Delivery Rules

See [repository-layout.md](repository-layout.md) for file ownership and retention. Track code, tests, reusable scripts, sanitized configuration, the lockfile, maintained docs/Skill and the accepted `test/bubble.cpp` example. Keep dependencies, builds, credentials, raw sessions, task snapshots, experiment scripts and task-specific handoffs local and ignored.

Private external-workload reports and task-specific handoffs are archived under ignored `.heteromcp/archive/` with manifests and hashes. They are not current engineering guidance, and live experiment paths are retained to preserve references. `npm run check:private` rejects tracked private-workload paths, and `npm run hooks:install` enables a pre-push guard; Git push is not a backup of local archives or task data.

Maintain English/Chinese architecture parity, README operational instructions and the governance Skill when durable contracts change. Do not copy full run transcripts or host-specific credentials/paths into these documents. Keep evidence summaries separate from current guarantees.

Next delivery priorities:

1. Preserve the working MCP dispatch, mutual-check, workflow and recovery contracts.
2. Add versioned acceptance/workspace semantics and a general deterministic evaluator beyond file scope.
3. Add bounded waiting/progress and reusable client interaction.
4. Expand to repository workers, durable artifact management and measured budget/retry policy.
5. Add providers/routing, task graphs and observability only as requirements justify them; evaluate a separate queue only after measured PostgreSQL limits.

## 9. Engineering Rules

- Keep TypeScript `strict`; accept external data as `unknown` and validate it.
- Preserve adapter boundaries and test them with provider/repository contracts.
- Return typed domain errors; never infer behavior by matching arbitrary error strings.
- Comments explain invariants, trade-offs, and non-obvious safety constraints, not syntax.
- Tests prioritize state transitions, idempotency, ownership, cancellation, budgets, error mapping, and context integrity.
- Performance work reports throughput, P50/P95 latency, error rate, and resource cost.
- Optimize context size, serialization, connection reuse, and batching before weakening boundaries.
- Never persist credentials or unrestricted prompts/tool output in task records, logs, or handoffs.
