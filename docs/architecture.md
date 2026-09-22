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
- MCP transport, state-machine, timeout, cancellation, recovery, and concurrency tests.

Current verification baseline: 20 tests, strict type checking, ESLint, Prettier, production build, and zero known production dependency vulnerabilities.

## 6. PostgreSQL Development Decision

PostgreSQL remains the durable store. Its deployment mechanism is outside the domain boundary.

- **Local development and real integration tests:** run standard PostgreSQL with Docker Compose.
- **Fast repository contract tests:** retain PGlite for deterministic, container-free feedback.
- **CI:** run fast tests on every change and a Docker PostgreSQL matrix for real multi-connection behavior.
- **Production:** connect to any supported PostgreSQL deployment through `HETEMCP_DATABASE_URL`; do not assume Docker.

Docker integration must verify concurrent claims, connection loss, process restart, long-running heartbeat, migration concurrency, and index behavior. PGlite passing is useful evidence but is not a substitute for those tests.

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

1. Add Docker Compose PostgreSQL and real-database integration tests.
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

