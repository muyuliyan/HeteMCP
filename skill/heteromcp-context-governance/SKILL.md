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

## Codex/CLI to DeepSeek Harness

Specialize incrementally: retain MCP, task state, repositories and leases. The coordinator plans and reviews; HeteMCP supervises execution; DeepSeek Harness runs bounded coding tasks. Keep provider independence at the harness adapter boundary.

- Target flow: MCP/CLI -> Orchestrator -> isolated workspace -> AgentHarness -> collected artifacts -> deterministic Evaluator -> result.
- Model inference and agent execution are different ports. An `AgentHarness` returns process/session outcome, never authoritative acceptance checks. Assemble `AttemptResult` only after independent validation; worker prose and exit zero alone cannot prove success.
- Start with the documented headless process interface; defer SDK sessions until measured need. Pin the deployed harness version and verify its CLI/protocol with an actual invocation; help alone may ignore unsupported arguments. Use stdin for prompts, NDJSON stdout, bounded diagnostics, explicit cwd/environment, and no shell interpolation. Require exit zero plus `final.reason.kind === completed`; preserve session identity and typed failures. Desktop 0.2.1-rc.2 lacks both the current final-event schema and `--permission-mode`: treat it as incompatible until a version-specific permission profile and protocol are verified. Never silently drop permission flags or relax completion validation.
- Cancellation must terminate and await the process tree before session reuse. Map approvals requiring a person to blocked; never bypass them. Do not advertise enforceable token/cost ceilings until the runtime actually enforces them.
- Give each attempt a separate worktree and durable artifact directory. Worktrees isolate edits, not host access; apply runtime permissions separately. Never grant shared Git metadata automatically or publish worker changes automatically.
- Collect actual patches and reports with hashes. Run structured, authorized acceptance commands and changed-path checks independently. Preserve V1 stored tasks; introduce a versioned contract when acceptance/workspace semantics change.
- Keep MCP and CLI on the same application service. Add bounded waiting and cursor-based progress after execution works; defer routers, task graphs, dashboards and distributed services.

Delivery checkpoints (verify each before advancing):

1. Harness port, headless adapter and process/protocol tests; probe the installed runtime if available.
2. Isolated workspace, artifact store and independent evaluator, then orchestration integration.
3. MCP waiting/progress and CLI entry point; real bounded coding-task acceptance.

Reference: [official headless contract](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.md). Record verified versus pending capabilities in `docs/architecture.md`; simulated harness tests are not evidence of a real model run.

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

