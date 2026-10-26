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

| Component | Owns | Must not own |
|---|---|---|
| MCP Gateway | Tool schemas and transport | Routing or task-state decisions |
| Orchestrator | State machine, timeout, cancellation, acceptance, lease ownership | Provider SDK details |
| Worker Loop | Recovery and queue draining | Domain policy |
| Policy Router | Candidate selection by capability, cost, latency, and risk | Permission bypass |
| Provider Adapter | Model request/response, streaming, usage, error mapping | Task persistence |
| Worker Runtime | Isolated tools, repository changes, artifact production | Unrestricted host access |
| Evaluator | Tests, policy checks, deterministic acceptance, optional model review | Treating subjective review as hard evidence |
| Task Repository | Atomic claim, revision checks, lease persistence | Business-state decisions |
| Artifact Store | Patches, logs, reports, hashes, retention | Large blobs embedded in task rows |
| Event/Telemetry | Traceable lifecycle events, metrics, cost | Secrets or unrestricted prompt content |

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

The repository currently provides:

- strict TypeScript and Zod schemas for tasks, context, artifacts, checks, usage, and results;
- deterministic task state transitions, idempotent creation, timeout, cancellation, and acceptance enforcement;
- a provider-neutral `ModelProvider` port and deterministic fake provider;
- MCP stdio tools: `create_task`, `get_task`, `cancel_task`, and `get_task_result`;
- in-memory and PostgreSQL repositories with optimistic revision checks;
- atomic queue claims using `FOR UPDATE SKIP LOCKED`;
- attempt IDs, worker IDs, heartbeat renewal, lease expiry, recovery, and stale-result rejection;
- a worker loop that recovers expired work and drains queued tasks;
- idempotent PostgreSQL migrations;
- shared repository contract tests for in-memory and PostgreSQL behavior;
- a Docker Compose PostgreSQL harness with separate real-database integration tests;
- MCP transport, state-machine, timeout, cancellation, recovery, and concurrency tests.

Current verification baseline: 20 fast tests, 6 real PostgreSQL integration tests, strict type checking, ESLint, Prettier, production build, and zero known production dependency vulnerabilities.

## 6. PostgreSQL Development Decision

PostgreSQL remains the durable store. Its deployment mechanism is outside the domain boundary.

| Concern | Decision and evidence |
|---|---|
| Fast feedback | PGlite runs the shared repository contract tests without a container. |
| Real database | Docker Compose runs PostgreSQL 17 for local development and integration tests; production uses `HETEMCP_DATABASE_URL` and does not depend on Docker. |
| Migration safety | A transaction-scoped advisory lock serializes metadata creation and all migration versions across concurrent service starts. |
| Verified behavior | `npm run test:integration:docker` passed 6 tests: independent-pool claims, connection loss, repository restart, heartbeat lease extension, concurrent migration startup, and partial-index query plans. The runner always removes test containers and volumes. |
| Operations | Use `npm run db:up` / `npm run db:down` for a retained local container; CI should run fast tests on every change and the real PostgreSQL suite before merge. |

Stage 1 is complete. PGlite remains fast feedback, not a substitute for real PostgreSQL evidence.

## 7. Not Yet Implemented

| Capability | Missing work |
|---|---|
| Real providers | OpenAI-compatible adapter, DeepSeek/GLM configuration, streaming, usage parsing, normalized errors |
| Isolated worker | Git worktree/container lifecycle, path and command allowlists, resource limits, cleanup |
| Artifact store | Durable patches, commits, logs, test reports, content hashes, retention and access control |
| Evaluator | Safe command execution, real test/lint/typecheck evidence, patch-scope checks, optional model review |
| Policy router | Capability/cost/latency/risk routing, availability fallback, escalation rules |
| Context compressor | Token measurement, automatic handoff generation, source references, completeness validation |
| Retry and budget policy | Error taxonomy, bounded backoff, attempt/deadline limits, enforced token and cost ceilings |
| Task graph | Parent/child tasks, dependencies, parallel branches, aggregation, coordinator plans |
| Observability | Lifecycle event store, OpenTelemetry traces, metrics, cost accounting, progress stream and dashboard |
| Security | Secret provider, authentication, approval gates, redaction, tenant boundaries, retention policy |

The current fake provider does not call a model or modify code. Without `HETEMCP_DATABASE_URL`, tasks remain process-local in memory.

## 8. Delivery Order

### Codex/CLI specialization (2026-10-26)

The immediate target is supervised DeepSeek Harness execution. Retain task persistence,
leases and MCP; add an `AgentHarness` port for complete agent runs, separate from model
inference and independent acceptance. `HarnessOutcome.completed` means a completed agent
turn, not a successful HeteMCP task. The existing fake-provider path remains a simulation.

The first implementation checkpoint adds `DeepSeekHeadlessAdapter`: an explicitly configured
absolute executable, fixed headless permission flags, stdin prompts, explicit environment,
bounded NDJSON/diagnostics, matching session/final validation and process-tree termination.
On Windows use an absolute Node executable and pinned CLI entrypoint as prefix arguments;
npm `.cmd` shims are not shell-free executables. The caller owns executable/version selection
and credential configuration. Raw tool output and reasoning are discarded in this checkpoint.
Errors are sanitized and no automatic retry is performed.

Local runtime probe: `D:\dsh\dddd` contains Desktop `0.2.1-rc.2`. Its bundled CLI is
`resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js`, launched by
`DeepSeek Harness.exe` with `ELECTRON_RUN_AS_NODE=1`. Headless help works. However, an
empty-stdin invocation with the intended flags exits 1 with `unknown option '--permission-mode'`.
Inspection of the bundled runner also shows a legacy final event containing only `type/text`.
The explicit desktop compatibility mode now supplies an audited profile overlay instead of
those unsupported flags. `config/deepseek-desktop-0.2.1.patch.yml` pins workspace-write and
approval never, enables the existing credential provider by path, and disables shell, web,
delegation and plugin-management tools. The inspected legacy runner exits zero only for a
completed turn; this mode requires both that exit code and a valid legacy final event following
the initial session event. Modern protocol validation remains strict. The installation is unchanged.

`src/index.ts` now offers an opt-in `deepseek-file-generation` executor via
`HETEMCP_DSH_DESKTOP`, `HETEMCP_CREDENTIALS_PATH`, and `HETEMCP_ALLOW_UNMETERED=1`.
The Orchestrator depends on `TaskExecutor`; the old ModelProvider name remains a compatibility
alias. `AgentHarness` reports execution only. `FileGenerationExecutor` creates a fresh empty
per-attempt directory, independently verifies one nonempty regular file (maximum 128 KiB), and
stores source/report artifacts with SHA-256 hashes. This new-file profile does not expose the
checkout to the worker and does not publish changes. It accepts only `generated-file-scope`;
task success does not claim compilation or semantic correctness. The supervisor runs those
checks separately before explicit publication. V1 usage adds `measured=false`, artifact metadata
adds optional SHA-256 and a `source` kind. Token/cost values remain advisory in this explicitly
unmetered profile; no production budget enforcement is claimed. MCP records remain process-local
without PostgreSQL, while the supervisor saves the final record under `.heteromcp/runs`.

Real verification on 2026-10-26: MCP stdio -> Orchestrator -> Desktop 0.2.1-rc.2 -> generated
`bubble.cpp`, task `4be8fde4-a5ac-4333-ab97-a745eec0091d`, session
`session-4f4df263-5835-4747-91a4-f76e76f48482`. The independent supervisor compiled with
C++17, `-Wall -Wextra -Werror -pedantic`, passed 57 valid and 3 invalid input cases, and copied
the worker's exact bytes to `test/bubble.cpp`. SHA-256:
`c9a3afcf0bbc5e17b1510a5fbcedb74629be41367bc49f5d50b130fcf4d1e3a5`.
See `docs/deepseek-smoke.md` for reproduction and evidence paths.

General repository worktrees, structured acceptance commands in a versioned task contract,
retry/budget enforcement and progress streaming remain future work. A worktree alone does
not enforce filesystem restrictions. Runtime session data lives in a private ignored directory;
it is not included in MCP responses or committed artifacts.

Checkpoints:

1. Harness/process protocol contract and simulated subprocess tests.
2. Per-attempt workspace, hashed artifacts, evaluator and orchestration integration.
3. MCP bounded wait/progress, CLI and a real bounded coding-task acceptance run.

The general roadmap below remains deferred where it exceeds this specialization.

1. [x] Add Docker Compose PostgreSQL and real-database integration tests.
2. Build the isolated worker and durable artifact store; produce a real patch and test report with the fake provider.
3. Add one OpenAI-compatible provider with normalized errors, streaming, usage, and budget enforcement.
4. Add the deterministic evaluator and bounded retry policy.
5. Add a second provider and policy router, then task graphs and coordinator-driven decomposition.
6. Add event streaming, OpenTelemetry/Langfuse-compatible tracing, cost reporting, and an operator dashboard.
7. Consider Temporal or a separate queue only after measured PostgreSQL queue limits.

## 9. Engineering Rules

- Keep TypeScript `strict`; accept external data as `unknown` and validate it.
- Preserve adapter boundaries and test them with provider/repository contracts.
- Return typed domain errors; never infer behavior by matching arbitrary error strings.
- Comments explain invariants, trade-offs, and non-obvious safety constraints, not syntax.
- Tests prioritize state transitions, idempotency, ownership, cancellation, budgets, error mapping, and context integrity.
- Performance work reports throughput, P50/P95 latency, error rate, and resource cost.
- Optimize context size, serialization, connection reuse, and batching before weakening boundaries.
- Never persist credentials or unrestricted prompts/tool output in task records, logs, or handoffs.
