# HeteMCP Architecture

> English source of truth for implementation. See [architecture.zh-CN.md](architecture.zh-CN.md) for the Chinese companion.

## 1. Purpose and Scope

HeteMCP is a provider-neutral orchestration service for heterogeneous model workers. A capable coordinator plans, routes, reviews, and escalates work; lower-cost models execute bounded tasks; Codex or another MCP client is the operator interface.

The target path is:

`MCP client -> orchestrator -> policy router -> provider/worker -> artifacts -> evaluator -> result`

The MVP prioritizes recoverable execution, explicit state, enforceable permissions, and verifiable output. It does not attempt autonomous agent organizations, general workflow DSLs, or distributed infrastructure without measured need.

## 2. Architectural Invariants

- **Deterministic control plane:** models propose actions; code enforces state transitions, leases, budgets, permissions, retries, and acceptance.
- **Provider isolation:** domain and orchestration code depend only on internal ports. Provider SDK details stay in adapters.
- **Artifact-backed completion:** a model response is not proof. Success requires acceptance evidence and durable artifacts.
- **Recoverable execution:** every attempt has an identity and a bounded lease. A stale attempt cannot overwrite a newer owner.
- **Context is not authority:** summaries and handoffs preserve decisions and evidence but never expand tool or filesystem permissions.
- **Modular monolith first:** boundaries are in-process interfaces until throughput or reliability data justifies another service.
- **Explicit failure:** no unbounded retry, silent fallback, or partial success reported as completion.

## 3. Component Boundaries

| Component        | Owns                                                                  | Must not own                                |
| ---------------- | --------------------------------------------------------------------- | ------------------------------------------- |
| MCP Gateway      | Tool schemas and transport                                            | Routing or task-state decisions             |
| Orchestrator     | State machine, timeout, cancellation, acceptance, lease ownership     | Provider SDK details                        |
| Worker Loop      | Recovery and queue draining                                           | Domain policy                               |
| Policy Router    | Candidate selection by capability, cost, latency, and risk            | Permission bypass                           |
| Provider Adapter | Model request/response, streaming, usage, error mapping               | Task persistence                            |
| Worker Runtime   | Isolated tools, repository changes, artifact production               | Unrestricted host access                    |
| Evaluator        | Tests, policy checks, deterministic acceptance, optional model review | Treating subjective review as hard evidence |
| Task Repository  | Atomic claim, revision checks, lease persistence                      | Business-state decisions                    |
| Artifact Store   | Patches, logs, reports, hashes, retention                             | Large blobs embedded in task rows           |
| Event/Telemetry  | Traceable lifecycle events, metrics, cost                             | Secrets or unrestricted prompt content      |

Dependency direction is `transport -> application -> domain`; provider, database, and worker implementations live under infrastructure.

## 4. Core Contracts

All boundary data is versioned and validated on entry. IDs are unguessable, timestamps use UTC ISO 8601, tokens are integers, and money uses integer micro-units.

### Task lifecycle

`queued -> running -> reviewing -> succeeded | failed`

Additional transitions support `blocked`, `cancelled`, and `running -> queued` after lease expiry. Only the Orchestrator decides business transitions; repositories apply atomic persistence operations.

### TaskSpecV1

Carries one verifiable objective, allowed and excluded paths, acceptance requirements, worker profile, token/cost limits, timeout, and a `ContextEnvelopeV1`.

### AttemptResultV1

Carries status, summary, artifact references, named check results, usage, and an optional typed error. A successful result must include an artifact and a passed check for every acceptance requirement.

### ContextEnvelopeV1

Carries only the current summary, decisions with reasons, traceable evidence, and unresolved questions. Large raw output belongs in the artifact store and is referenced rather than copied.

## 5. Implemented Baseline

The current supported path is supervised single-file generation:

`Codex/MCP client -> MCP stdio -> Orchestrator -> TaskExecutor -> FileGenerationExecutor -> AgentHarness -> DSH -> scope checks/artifacts -> result -> supervisor acceptance/publication`

Codex is the coordinating client, not an implemented execution adapter. `TaskExecutor` is the application execution port; `ModelProvider` remains a compatibility alias. `AgentHarness` reports process/session outcomes, not authoritative task acceptance. The policy router, general worker runtime, artifact service and evaluator in section 3 are target boundaries; their general implementations are still pending.

Implemented capabilities:

- strict TypeScript/Zod task, context, artifact, check, usage and result contracts;
- idempotent creation, execution deduplication, timeout, cancellation and acceptance state transitions;
- MCP stdio tools `create_task`, `get_task`, `cancel_task`, `get_task_result`;
- in-memory/PostgreSQL repositories, revision checks, atomic claims (`FOR UPDATE SKIP LOCKED`), heartbeat renewal, lease recovery and stale-result rejection;
- a recovery/queue worker loop and transactionally serialized, idempotent migrations;
- deterministic fake execution by default and opt-in DSH Desktop `0.2.1-rc.2` file generation;
- shell-free subprocess execution, bounded NDJSON/diagnostics, session/final validation and process-tree cancellation;
- per-attempt empty workspaces, independent file scope inspection, SHA-256 source/report references;
- a real MCP client script and a separate C++ compiler/behavior verifier with explicit publication;
- automated domain, orchestration, process/protocol, file-scope, transport and shared repository contract tests; a separate real PostgreSQL integration suite.

Verification commands are `npm run check` and `npm run build`; use `npm run test:integration:docker` for real PostgreSQL. Test counts and dependency audit results are time-specific evidence, not permanent architectural guarantees. Real DSH evidence is recorded in [deepseek-smoke.md](deepseek-smoke.md); a simulated subprocess test does not establish model connectivity.

## 6. Runtime and Persistence Decisions

### Configuration and Codex supervision

Run the server from the repository root: policy and private runtime paths resolve from cwd. MCP uses `node <absolute-repository-path>/dist/index.js`; stdout is protocol-only. Codex or another MCP client supplies the actual service environment. The service does not automatically load `.env`.

`HETEMCP_DSH_DESKTOP` selects real file generation. It also requires `HETEMCP_CREDENTIALS_PATH` and explicit `HETEMCP_ALLOW_UNMETERED=1`. Without the desktop variable, execution is fake. `HETEMCP_DATABASE_URL` independently selects PostgreSQL; otherwise records are process-local. `scripts/run-file-task.ts` explicitly forwards these variables plus optional `HETEMCP_ARTIFACT_ROOT` to its MCP subprocess. Merely setting a parent variable is insufficient if a custom client omits it from its transport environment.

All four tools return the complete record at `structuredContent.task` on success; check `isError` before reading it. `get_task_result` does not perform compilation or wait for completion. The example client polls with a supervisor deadline and requests cancellation on expiry. It generates a new idempotency key per invocation; clients retrying the same submission must reuse their key.

### DSH Desktop compatibility

The pinned desktop adapter launches `DeepSeek Harness.exe` as Node (`ELECTRON_RUN_AS_NODE=1`) with its bundled `resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js`. Use absolute executable/entrypoint paths, stdin prompts and explicit environment; no npm `.cmd` shim or shell interpolation.

Desktop `0.2.1-rc.2` does not support the modern `--permission-mode` interface. Its explicit legacy mode uses `--profile headless --patch ...` and [the audited overlay](../config/deepseek-desktop-0.2.1.patch.yml): workspace-write, approval never, native credentials by path, `deepseek-official/deepseek-flash`, shell/web/delegation/plugin-management tools disabled. It uses private `.heteromcp/dsh-home`, leaving the personal profile unchanged. Credentials are loaded by the native plugin, never embedded in tasks.

Legacy completion requires the initial session, a valid legacy final and exit zero, based on inspected runner semantics. Modern mode additionally requires the completed final reason and matching session identity. Never select legacy mode automatically because output is malformed. Recheck CLI, protocol and policy before supporting another version; a successful help invocation is insufficient. No automatic model-call retry or broader permission fallback is implemented.

### File generation and acceptance

The executor accepts only `workerProfile=deepseek-file-generation`, one plain filename matching `.cpp`, `.txt` or `.md`, no excluded paths and exactly `generated-file-scope` acceptance. Each attempt creates a fresh empty directory rather than exposing the checkout. It independently verifies exactly one nonempty regular file, at most 128 KiB, and stores SHA-256 references to source and report.

`HarnessOutcome.completed` proves a completed turn. Task `succeeded` in this profile proves that turn plus file-scope validation. Neither proves compilation, behavior, numerical correctness or performance. Independent supervisor checks precede explicit publication; preserve worker bytes when coding is assigned exclusively to DSH. `scripts/verify-bubble.ts` verifies the source hash, compiles/tests and only publishes with `--publish`, refusing a nonempty destination.

Token/cost ceilings in V1 are advisory for this profile. `usage.measured=false` with zero counters means unknown, not free. Explicit unmetered opt-in is required; the wall-clock timeout is enforced. Generic acceptance-command execution, enforceable resource ceilings and repository patch validation remain future work.

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
| Provider inference    | OpenAI-compatible inference adapter, streaming, measured usage and normalized errors; DSH agent execution is already integrated separately |
| Budgets/retries       | Enforced token/cost ceilings, bounded retry/backoff and deadline/attempt policy                                                            |
| MCP interaction       | Bounded server-side waiting and cursor-based progress; the current client polls                                                            |
| Routing/task graphs   | Capability/cost/risk selection, fallback, dependencies, aggregation and decomposition                                                      |
| Context/observability | Automated compression/handoff validation, lifecycle event store, traces, metrics and cost accounting                                       |
| Service security      | Authentication, tenant isolation, secret management and production retention controls                                                      |

Implement a versioned contract when acceptance or workspace semantics change; preserve stored V1 records. A Git worktree isolates edits but is not a host filesystem sandbox. The current file-generation profile is a supported bounded workflow, not a general production worker.

## 8. Repository and Delivery Rules

See [repository-layout.md](repository-layout.md) for file ownership and retention. Track code, tests, reusable scripts, sanitized configuration, the lockfile, maintained docs/Skill and the accepted `test/bubble.cpp` example. Keep dependencies, builds, credentials, raw sessions, task snapshots, experiment scripts and task-specific handoffs local and ignored.

On 2026-10-28, eight MLA experiment reports and their task-specific Skill were archived under private `.heteromcp/archive/2026-10-28/` with original paths and SHA-256 manifest. These historical external-workload records are not current engineering guidance. Existing artifact/runtime paths were retained to preserve references. Git push is not a backup of local archives or task data.

Maintain English/Chinese architecture parity, README operational instructions and the governance Skill when durable contracts change. Do not copy full run transcripts or host-specific credentials/paths into these documents. Keep evidence summaries separate from current guarantees.

Next delivery priorities:

1. Preserve the working MCP/DSH generation and recovery contracts.
2. Add versioned acceptance/workspace semantics and a general independent evaluator.
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
