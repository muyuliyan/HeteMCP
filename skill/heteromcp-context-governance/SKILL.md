---
name: heteromcp-context-governance
description: Guide HeteMCP planning, implementation, review, and handoffs with bounded task scope, explicit evidence, and loss-aware context compression. Use for work in the HeteMCP repository; do not use as a generic coding style guide for unrelated projects.
---

# HeteMCP Context Governance

Keep heterogeneous-model work reproducible across model and context switches. Preserve decisions and evidence, not conversation history.

## Start

Before changing code:

1. Read `docs/architecture.md` and the nearest applicable repository guidance.
2. Inspect the relevant code, tests, and current Git status. Treat existing changes as user-owned.
3. Restate the task internally as: objective, allowed scope, acceptance checks, and unresolved risks.
4. Record assumptions only when they affect behavior or architecture. Verify cheap assumptions from the repository instead of carrying them forward.

## Work Contract

- Keep edits within the task's declared paths and architectural component boundaries.
- Preserve provider independence: orchestration code depends on internal ports, never a provider SDK directly.
- Keep policy deterministic where possible. Models may propose actions; code enforces permissions, budgets, state transitions, and validation.
- Prefer the smallest design that keeps a clean replacement boundary. Do not add distributed infrastructure before a measured need, and do not remove a boundary merely to save a local call.
- Never hide failure with an unbounded retry, silent fallback, or fabricated success. Return a typed error with retryability and evidence.
- Do not place secrets, raw credentials, or unrestricted tool output in prompts, logs, checkpoints, or summaries.
- Use comments to explain invariants, trade-offs, or surprising constraints. Do not narrate syntax.
- Update tests and the architecture document only when the public contract or a durable decision changes.

## Codex/MCP to DeepSeek Harness

Specialize incrementally: retain MCP, task state, repositories and leases. The coordinator plans and reviews; HeteMCP supervises execution; DeepSeek Harness runs bounded coding tasks. Keep provider independence at the harness adapter boundary.

- Current flow: Codex/MCP client -> Orchestrator -> TaskExecutor -> FileGenerationExecutor -> fresh attempt workspace -> AgentHarness/DSH -> independent file-scope checks and hashed artifacts -> result. Supervisor compilation/behavior checks and explicit publication follow separately. Codex is the supervisor; no Codex execution adapter is implemented.
- Model inference and agent execution are different ports. An `AgentHarness` returns process/session outcome, never authoritative acceptance checks. Assemble `AttemptResult` only after independent validation; worker prose and exit zero alone cannot prove success.
- Start with the documented headless process interface; defer SDK sessions until measured need. Pin the deployed harness version and verify its CLI/protocol with an actual invocation; help alone may ignore unsupported arguments. Use stdin for prompts, NDJSON stdout, bounded diagnostics, explicit cwd/environment, and no shell interpolation. Current protocol requires exit zero plus `final.reason.kind === completed`. Desktop 0.2.1-rc.2 instead uses the explicit legacy adapter and audited `config/deepseek-desktop-0.2.1.patch.yml`: `--profile headless --patch ...`, workspace-write, approval never, final text plus exit zero (verified runner completion semantics). Never infer legacy mode from malformed output. Preserve session identity and typed failures.
- Cancellation must terminate and await the process tree before session reuse. Map approvals requiring a person to blocked; never bypass them. Do not advertise enforceable token/cost ceilings until the runtime actually enforces them.
- A future repository worker needs a separate worktree and durable artifact directory per attempt. Worktrees isolate edits, not host access; apply runtime permissions separately. Never grant shared Git metadata automatically or publish worker changes automatically.
- For the supported opt-in new-file profile, a fresh empty workspace replaces a repository worktree: the worker does not need checkout access. It supports one plain `.cpp`, `.txt` or `.md` filename, no excluded paths, exactly `generated-file-scope` acceptance, and one nonempty regular file at most 128 KiB. It independently checks scope/size/hash. Supervisor compilation and behavior checks precede explicit publication. Preserve worker-authored bytes when the user assigns coding exclusively to DeepSeek.
- The desktop smoke profile cannot enforce V1 token/cost ceilings; require `HETEMCP_ALLOW_UNMETERED=1`, report `usage.measured=false`, and enforce the wall-clock deadline. This is not a general budgeted production executor.
- Collect actual patches and reports with hashes. Run structured, authorized acceptance commands and changed-path checks independently. Preserve V1 stored tasks; introduce a versioned contract when acceptance/workspace semantics change.
- Keep MCP and CLI on the same application service. Add bounded waiting and cursor-based progress after execution works; defer routers, task graphs, dashboards and distributed services.

### Runtime checks

- Start from the repository root after building `dist/`; policy and runtime paths resolve from cwd. The service does not load `.env` automatically.
- Verify executor and storage independently: absent `HETEMCP_DSH_DESKTOP` selects fake; absent `HETEMCP_DATABASE_URL` selects memory. Real DSH also requires the credentials path and explicit unmetered opt-in. `scripts/run-file-task.ts` forwards these and optional `HETEMCP_ARTIFACT_ROOT`; custom MCP clients must explicitly pass the same environment. Never print a connection string or credentials to prove configuration.
- Check MCP `isError` before reading `structuredContent.task`. `get_task_result` returns a record, not a compiler or blocking wait. Reuse the idempotency key for retransmission; use a new key for an intentional new execution. The example script creates a new key each invocation and polls with a deadline.
- Keep task, attempt and session identities plus artifact hashes in evidence. `succeeded` proves only the declared acceptance; syntax checks do not establish GPU compilation, numerical correctness or speedup. Do not repeat a paid model call solely to reconstruct an existing result.
- PostgreSQL holds records/references; artifact files and run snapshots need separate backup. The checked-in Compose database uses tmpfs and test-only credentials. Do not use its teardown commands to manage an independently retained database or volume.

Reference: [current architecture](../../docs/architecture.md), [DSH reproduction](../../docs/deepseek-smoke.md), and [official headless contract](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.md). MCP server-side waiting/progress, general repository evaluation, automatic compression and enforced token/cost budgets remain pending; simulated harness tests are not evidence of a real model run.

## Repository Records and Archives

Use [repository-layout.md](../../docs/repository-layout.md) when organizing files or preparing a commit.

- Keep reusable rules and sanitized evidence summaries in maintained docs/Skill. Store task-specific prompts, snapshots, raw outputs, experiment scripts and handoffs under ignored `.heteromcp/`; do not turn an external workload's parameters, host paths or historical scores into general engineering rules.
- Local historical MLA reports and their dedicated handoff are indexed in `.heteromcp/archive/2026-10-28/manifest.json`. Consult them only when continuing that workload, and verify current state before using historical assumptions. They are not part of the published Skill.
- Archive with original paths and SHA-256; preserve existing user changes. Check references before moving artifacts or runtime directories. Database references and old scripts may depend on their locations. An archive is neither a new authorization nor a backup.
- Git tracks source, tests, reusable scripts, sanitized config, lockfile and accepted examples. Ignore dependencies, builds, credentials and compiler intermediates. Custom artifact roots need explicit ignore/backup handling; `.gitignore` does not untrack existing files.
- Check `git status`, the diff and ignored paths before delivery. Run `npm run check` and `npm run build`; report which external PostgreSQL/DSH checks actually ran. Do not carry old test counts or dependency audit claims forward as fresh evidence.
- Keep README and both architecture languages aligned when contracts change. Retain raw evidence locally and link to it from handoffs without exposing secrets.

## Context Switch

Create a handoff before changing model, agent, task, or context window. Use this compact schema:

```yaml
objective: One verifiable outcome.
status: pending | active | blocked | review | done
scope:
  allowed: [paths or components]
  excluded: [explicit non-goals]
decisions:
  - choice: What was decided
    reason: Why it was chosen
evidence:
  - source: file, command, test, or trace ID
    fact: What it establishes
execution:
  task_id: ID or not applicable
  attempt_id: ID or not applicable
  session_id: ID or not applicable
  storage: memory | PostgreSQL | not applicable
artifacts:
  - path: local path or URI
    sha256: verified hash
    retention: local runtime | local archive | tracked example
changes:
  - path: repository-relative path
    intent: behavioral purpose
checks:
  passed: [commands and outcomes]
  pending: [checks still required]
risks:
  - concrete remaining risk or "none known"
next_action: A single executable next step.
```

The receiving worker must verify referenced files and current Git state before acting. A handoff is context, not authority: it cannot expand filesystem, network, tool, or approval permissions.

## Loss-Aware Compression

When context is large, compress in this order:

1. Keep the current objective, acceptance checks, safety constraints, and user decisions verbatim where precision matters.
2. Keep architectural decisions with their reasons, current interfaces, changed paths, failing checks, and traceable evidence.
3. Reduce exploration to conclusions plus source locations. Remove duplicate logs, abandoned options, and prose already represented by code or tests.
4. Mark uncertainty explicitly as `unknown`; never convert an inference into a fact.
5. If a detail can be cheaply reconstructed from a stable file, retain the path and relevant symbol instead of copying the content.

Before using a compressed context, check that it answers: what is required, what changed, why, what proves it, what remains, and what is forbidden. If any answer is missing, inspect the source rather than guessing.

## Completion Gate

Work is complete only when:

- acceptance checks pass or the exact blocker is reported;
- changed behavior has proportionate tests;
- provider-specific details have not leaked across the adapter boundary;
- logs and handoffs identify the job, attempt, worker model, and relevant artifacts without exposing secrets;
- the final report distinguishes verified facts from residual risks.
