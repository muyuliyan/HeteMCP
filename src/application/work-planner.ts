import { createHash, randomUUID } from "node:crypto";

import { DomainError } from "../domain/errors.js";
import {
  normalizeExecutionMode,
  taskSpecSchema,
  type Budget,
  type CapabilityCatalog,
  type TaskRecord,
  type TaskSpec,
} from "../domain/schemas.js";
import {
  workPacketSchema,
  workRequestSchema,
  type WorkDecision,
  type WorkPacket,
  type WorkPhase,
  type WorkRequest,
  type WorkSignals,
  type WorkTaskMode,
} from "../domain/work-packet.js";

const defaultBudget: Budget = {
  maxInputTokens: 20_000,
  maxOutputTokens: 4_000,
  maxCostMicros: 0,
};
const defaultTimeoutMs = 900_000;
const maxReviewers = 2;
const managerDesignPlaceholder = "Manager design will be supplied via execute_work_packet.";
const noManagerDesignSummary = "No separate manager design; use the objective and context below.";

export interface WorkPlannerOptions {
  now?: () => Date;
  createId?: () => string;
  sourceTask?: TaskRecord;
  maxAttempts?: number;
}

interface WorkerSelection {
  name?: string;
  reason: string;
  available: boolean;
}

interface ReviewerSelection {
  names: string[];
  reason: string;
}

// Deterministic policy layer: the manager supplies signals, the planner owns
// mode selection, role assignment, task shaping and the packet hash.
export function planWork(
  rawRequest: WorkRequest,
  catalog: CapabilityCatalog,
  options: WorkPlannerOptions = {},
): WorkPacket {
  const request = workRequestSchema.parse(rawRequest);
  const requestedMode = request.requestedMode
    ? normalizeExecutionMode(request.requestedMode)
    : undefined;
  const agents = catalog.agents.filter((agent) => agent.available && agent.name !== "fake");
  const fakeAvailable = catalog.agents.some((agent) => agent.available && agent.name === "fake");
  const worker = selectWorker(request, agents, fakeAvailable);
  const reviewers = selectReviewers(request, agents, worker.name);
  const allReviewers = selectReviewers(request, agents, undefined);
  const signals = buildSignals(request, reviewers.names.length);
  const decision = decide(
    request,
    requestedMode,
    worker,
    reviewers,
    allReviewers,
    signals,
    options.sourceTask,
  );
  const effectiveReviewers = decision.strategy === "review-only" ? allReviewers : reviewers;
  const finalDecision: WorkDecision = {
    ...decision,
    signals: buildSignals(request, effectiveReviewers.names.length),
  };
  const artifactName = request.artifactName ?? defaultArtifactName(request.taskKind);
  const taskTemplate = buildTaskTemplate({
    request,
    decision: finalDecision,
    worker,
    reviewers: effectiveReviewers,
    sourceTask: options.sourceTask,
    artifactName,
  });
  const maxAttempts = options.maxAttempts ?? 2;
  const assignedWorker =
    finalDecision.strategy === "review-only" || finalDecision.strategy === "blocked"
      ? undefined
      : worker.name;
  const assignedReviewers =
    finalDecision.strategy === "review-only" || finalDecision.strategy === "cross-check"
      ? effectiveReviewers.names
      : [];
  const packetInput: Omit<WorkPacket, "planHash"> = {
    version: 1,
    planId: options.createId?.() ?? randomUUID(),
    createdAt: (options.now?.() ?? new Date()).toISOString(),
    request,
    decision: finalDecision,
    roles: {
      planner: "manager",
      ...(assignedWorker === undefined ? {} : { worker: assignedWorker }),
      reviewers: assignedReviewers,
      verifier: finalDecision.strategy === "cross-check" ? "harness+manager" : "manager",
    },
    phases: buildPhases(request, finalDecision, artifactName),
    ...(taskTemplate === undefined ? {} : { taskTemplate }),
    managerInstructions: buildManagerInstructions(
      request,
      finalDecision,
      artifactName,
      worker,
      effectiveReviewers,
      maxAttempts,
    ),
    stopConditions: buildStopConditions(finalDecision, maxAttempts),
    escalation: buildEscalation(finalDecision, worker, effectiveReviewers),
  };
  const parsed = workPacketSchema.parse({
    ...packetInput,
    planHash: "0".repeat(64),
  });
  const planHash = computePlanHash(parsed);
  return { ...parsed, planHash };
}

export function computePlanHash(packet: WorkPacket | Omit<WorkPacket, "planHash">): string {
  const clone = structuredClone(packet) as Record<string, unknown>;
  delete clone.planHash;
  return createHash("sha256").update(canonicalJson(clone)).digest("hex");
}

export function assertWorkPacketHash(packet: WorkPacket): void {
  if (computePlanHash(packet) !== packet.planHash) {
    throw new DomainError(
      "PACKET_INVALID",
      "Work packet hash mismatch; call plan_work again instead of editing the packet",
    );
  }
}

export function buildTaskFromWorkPacket(packet: WorkPacket, design?: string): TaskSpec {
  assertWorkPacketHash(packet);
  if (packet.decision.strategy === "blocked") {
    throw new DomainError("PACKET_BLOCKED", packet.decision.reason);
  }
  const template = packet.taskTemplate;
  if (!template) {
    throw new DomainError("PACKET_INVALID", "Work packet has no task template");
  }
  assertPacketConsistency(packet, template);

  const designRequired = packet.phases.some((phase) => phase.id === "design" && phase.required);
  const trimmedDesign = design?.trim();
  if (designRequired && !trimmedDesign) {
    throw new DomainError(
      "DESIGN_REQUIRED",
      "This work packet requires a manager design before dispatch",
    );
  }

  const baseSummary =
    template.context.summary === managerDesignPlaceholder ? "" : template.context.summary;
  const summary =
    [trimmedDesign ? `Manager design:\n${trimmedDesign}` : "", baseSummary]
      .filter(Boolean)
      .join("\n\n") || "No additional context.";
  const decisions = trimmedDesign
    ? [
        ...template.context.decisions,
        {
          choice: "manager design supplied",
          reason: "provided through execute_work_packet",
        },
      ]
    : template.context.decisions;

  return taskSpecSchema.parse({
    ...template,
    context: { ...template.context, summary, decisions },
  });
}

function selectWorker(
  request: WorkRequest,
  agents: readonly { name: string }[],
  fakeAvailable: boolean,
): WorkerSelection {
  if (request.preferredWorker) {
    const name = request.preferredWorker.toLowerCase();
    if (name === "fake") {
      return fakeAvailable
        ? {
            name,
            reason: "Explicit fake worker for a deterministic run.",
            available: true,
          }
        : {
            reason: "Preferred worker fake is not configured.",
            available: false,
          };
    }
    return agents.some((agent) => agent.name === name)
      ? {
          name,
          reason: `Explicit worker ${name}.`,
          available: true,
        }
      : {
          reason: `Preferred worker ${name} is unavailable.`,
          available: false,
        };
  }

  for (const name of ["deepseek", "codex", "claude"]) {
    if (agents.some((agent) => agent.name === name)) {
      return {
        name,
        reason: `Default worker priority selects ${name}.`,
        available: true,
      };
    }
  }
  return {
    reason: "No real worker agent is available.",
    available: false,
  };
}

function selectReviewers(
  request: WorkRequest,
  agents: readonly { name: string }[],
  workerName: string | undefined,
): ReviewerSelection {
  const available = new Set(agents.map((agent) => agent.name));
  if (request.preferredReviewers.length > 0) {
    const names: string[] = [];
    const unavailable: string[] = [];
    for (const raw of request.preferredReviewers) {
      const name = raw.toLowerCase();
      if (name === workerName) continue;
      if (available.has(name)) names.push(name);
      else unavailable.push(name);
    }
    return {
      names: [...new Set(names)].slice(0, maxReviewers),
      reason:
        unavailable.length > 0
          ? `Unavailable preferred reviewers: ${unavailable.join(", ")}.`
          : "Using explicit preferred reviewers.",
    };
  }

  const names = [...available].filter((name) => name !== workerName).slice(0, maxReviewers);
  return {
    names,
    reason:
      names.length > 0 ? "Auto-selected available reviewers." : "No reviewer agent is available.",
  };
}

function buildSignals(request: WorkRequest, reviewerCount: number): WorkSignals {
  const risk = { low: 0, medium: 2, high: 4 }[request.risk];
  const ambiguity = { low: 0, medium: 1, high: 2 }[request.ambiguity];
  const kind = { code: 1, document: 0, analysis: 1, review: 2, other: 0 }[request.taskKind];
  const independent = request.requiresIndependentVerification ? 3 : 0;
  const planning = request.managerCanPlan ? 1 : 0;
  const verification = request.managerCanReview ? 1 : 0;
  const reviewCapacity = reviewerCount > 0 ? 2 : 0;
  return {
    score: risk + ambiguity + kind + independent + planning + verification + reviewCapacity,
    risk: request.risk,
    ambiguity: request.ambiguity,
    taskKind: request.taskKind,
    requiresIndependentVerification: request.requiresIndependentVerification,
    reviewerCount,
    factors: [
      { name: "risk", value: risk, reason: `${request.risk} risk` },
      {
        name: "ambiguity",
        value: ambiguity,
        reason: `${request.ambiguity} ambiguity`,
      },
      { name: "taskKind", value: kind, reason: request.taskKind },
      {
        name: "independentVerification",
        value: independent,
        reason: request.requiresIndependentVerification
          ? "independent verification required"
          : "independent verification not required",
      },
      {
        name: "managerCanPlan",
        value: planning,
        reason: request.managerCanPlan ? "manager can design" : "manager cannot design",
      },
      {
        name: "managerCanReview",
        value: verification,
        reason: request.managerCanReview ? "manager can verify" : "manager cannot verify",
      },
      {
        name: "reviewerCount",
        value: reviewCapacity,
        reason: `${String(reviewerCount)} available reviewer(s)`,
      },
    ],
  };
}

function decide(
  request: WorkRequest,
  requestedMode: WorkTaskMode | undefined,
  worker: WorkerSelection,
  reviewers: ReviewerSelection,
  allReviewers: ReviewerSelection,
  signals: WorkSignals,
  sourceTask: TaskRecord | undefined,
): WorkDecision {
  const blocked = (reason: string, matchedRule: string): WorkDecision => ({
    strategy: "blocked",
    reason,
    matchedRule,
    confidence: "low",
    signals,
  });
  const dispatch = (
    reason: string,
    matchedRule: string,
    confidence: "low" | "medium" | "high",
  ): WorkDecision => ({
    strategy: "dispatch",
    taskMode: "dispatch",
    reason,
    matchedRule,
    confidence,
    signals,
  });
  const supervised = (
    reason: string,
    matchedRule: string,
    confidence: "low" | "medium" | "high",
  ): WorkDecision => ({
    strategy: "supervised",
    taskMode: "dispatch",
    reason,
    matchedRule,
    confidence,
    signals,
  });
  const crossCheck = (
    reason: string,
    matchedRule: string,
    confidence: "low" | "medium" | "high",
  ): WorkDecision => ({
    strategy: "cross-check",
    taskMode: "workflow",
    reason,
    matchedRule,
    confidence,
    signals,
  });
  const reviewOnly = (reason: string): WorkDecision => ({
    strategy: "review-only",
    taskMode: "mutual-check",
    reason,
    matchedRule: "existing-artifact-review",
    confidence: "high",
    signals,
  });

  const sourceHasFile =
    sourceTask?.result?.artifacts.some((artifact) => artifact.uri.startsWith("file:")) ?? false;
  const fakeWorkerSelected = worker.name === "fake";

  if (request.taskKind === "review" && !request.sourceTaskId) {
    return blocked(
      "Review work requires sourceTaskId pointing to an existing artifact.",
      "review-without-source",
    );
  }

  if (request.sourceTaskId) {
    if (requestedMode === "dispatch" || requestedMode === "workflow") {
      return blocked(
        "sourceTaskId is only valid for mutual-check or auto review.",
        "source-with-non-review-mode",
      );
    }
    if (!sourceTask) {
      return blocked(
        "The source task was not resolved; call get_task first.",
        "source-not-resolved",
      );
    }
    if (!sourceHasFile) {
      return blocked(
        "The source task has no file-backed artifact to review.",
        "source-no-file-artifact",
      );
    }
    if (allReviewers.names.length === 0) {
      return blocked(
        "Mutual-check requires at least one available harness reviewer.",
        "review-no-reviewer",
      );
    }
    return reviewOnly("An existing artifact was supplied; run the selected reviewers on it.");
  }

  if (requestedMode === "mutual-check") {
    return blocked(
      "mutual-check requires sourceTaskId pointing to an existing artifact.",
      "mutual-check-without-source",
    );
  }

  if (!worker.available) {
    return blocked(
      worker.reason,
      worker.reason.startsWith("Preferred worker") ? "preferred-worker-unavailable" : "no-worker",
    );
  }

  if (requestedMode === "dispatch") {
    if (request.reviewBy === "harness" || request.preferredReviewers.length > 0) {
      return blocked(
        "Dispatch mode does not run reviewers; use workflow or clear preferredReviewers.",
        "dispatch-with-reviewers",
      );
    }
    return dispatch("The caller explicitly requested dispatch.", "explicit-dispatch", "high");
  }

  if (requestedMode === "workflow") {
    if (request.reviewBy === "manager") {
      if (!request.managerCanReview) {
        return blocked(
          "Manager review was requested but the manager cannot verify.",
          "workflow-manager-review-unavailable",
        );
      }
      if (fakeWorkerSelected) {
        return blocked(
          "Fake workers only support dispatch tests; select a real agent.",
          "fake-worker-workflow",
        );
      }
      return supervised(
        "Workflow with manager verification: the manager designs, the worker implements, and the manager verifies.",
        "explicit-workflow-manager-review",
        "high",
      );
    }
    if (request.reviewBy === "harness") {
      if (reviewers.names.length === 0) {
        return blocked(
          "Workflow requested harness review but no harness reviewer is available.",
          "workflow-no-harness-reviewer",
        );
      }
      if (fakeWorkerSelected) {
        return blocked(
          "Fake workers cannot produce file artifacts for cross-check.",
          "fake-worker-cross-check",
        );
      }
      return crossCheck(
        "Workflow with harness cross-check.",
        "explicit-workflow-harness-review",
        "high",
      );
    }

    if (request.preferredReviewers.length > 0 && reviewers.names.length > 0) {
      if (fakeWorkerSelected) {
        return blocked(
          "Fake workers cannot produce file artifacts for cross-check.",
          "fake-worker-cross-check",
        );
      }
      return crossCheck(
        "Workflow uses the explicitly preferred harness reviewers.",
        "workflow-preferred-reviewers",
        "high",
      );
    }
    if (request.managerCanReview) {
      if (fakeWorkerSelected) {
        return blocked(
          "Fake workers only support dispatch tests; select a real agent.",
          "fake-worker-workflow",
        );
      }
      return supervised(
        "Workflow defaults to manager verification when no harness reviewers are requested.",
        "workflow-manager-default",
        "medium",
      );
    }
    if (reviewers.names.length > 0) {
      if (fakeWorkerSelected) {
        return blocked(
          "Fake workers cannot produce file artifacts for cross-check.",
          "fake-worker-cross-check",
        );
      }
      return crossCheck(
        "Manager review is unavailable; workflow falls back to harness reviewers.",
        "workflow-harness-fallback",
        "medium",
      );
    }
    return blocked(
      "Workflow requires either manager verification or an available harness reviewer.",
      "workflow-no-verifier",
    );
  }

  if (request.reviewBy === "manager") {
    if (!request.managerCanReview) {
      return blocked(
        "Manager review was requested but the manager cannot verify.",
        "manager-review-unavailable",
      );
    }
    if (fakeWorkerSelected) {
      return blocked(
        "Fake workers only support dispatch tests; select a real agent.",
        "fake-worker-supervised",
      );
    }
    return supervised(
      "Manager review was explicitly requested.",
      "explicit-manager-review",
      "high",
    );
  }

  if (request.reviewBy === "harness") {
    if (reviewers.names.length === 0) {
      return blocked(
        "Harness review was requested but no harness reviewer is available.",
        "harness-review-unavailable",
      );
    }
    if (fakeWorkerSelected) {
      return blocked(
        "Fake workers cannot produce file artifacts for cross-check.",
        "fake-worker-cross-check",
      );
    }
    return crossCheck(
      "Harness review was explicitly requested.",
      "explicit-harness-review",
      "high",
    );
  }

  const highRisk = request.risk === "high" || request.requiresIndependentVerification;
  const needsVerification =
    request.risk !== "low" ||
    request.ambiguity !== "low" ||
    request.taskKind === "code" ||
    request.taskKind === "review";

  if (highRisk) {
    if (reviewers.names.length > 0) {
      if (fakeWorkerSelected) {
        return blocked(
          "Fake workers cannot produce file artifacts for cross-check.",
          "fake-worker-cross-check",
        );
      }
      return crossCheck(
        "High-risk or independently verified work uses harness cross-check.",
        "high-risk-cross-check",
        "high",
      );
    }
    if (request.managerCanReview) {
      if (fakeWorkerSelected) {
        return blocked(
          "Fake workers only support dispatch tests; select a real agent.",
          "fake-worker-supervised",
        );
      }
      return supervised(
        "High-risk work has no harness reviewer; the manager verifies.",
        "high-risk-manager-review",
        "medium",
      );
    }
    return blocked(
      "High-risk work requires a verifier, but no reviewer is available.",
      "high-risk-no-verifier",
    );
  }

  if (needsVerification) {
    if (request.managerCanPlan && request.managerCanReview) {
      if (fakeWorkerSelected) {
        return blocked(
          "Fake workers only support dispatch tests; select a real agent.",
          "fake-worker-supervised",
        );
      }
      return supervised(
        "Medium-risk or ambiguous work uses manager design and verification.",
        "medium-risk-supervised",
        "medium",
      );
    }
    if (reviewers.names.length > 0) {
      if (fakeWorkerSelected) {
        return blocked(
          "Fake workers cannot produce file artifacts for cross-check.",
          "fake-worker-cross-check",
        );
      }
      return crossCheck(
        "Manager design or verification is unavailable; use harness reviewers.",
        "medium-risk-cross-check",
        "medium",
      );
    }
    return blocked(
      "Work requires verification, but no manager or harness verifier is available.",
      "medium-risk-no-verifier",
    );
  }

  return dispatch(
    "Low-risk bounded work without independent verification.",
    "low-risk-dispatch",
    "medium",
  );
}

function buildPhases(
  request: WorkRequest,
  decision: WorkDecision,
  artifactName: string,
): WorkPhase[] {
  if (decision.strategy === "blocked") {
    return [
      {
        id: "unblock",
        actor: "manager",
        action: "unblock",
        tool: "plan_work",
        inputs: ["blocked reason"],
        outputs: ["revised request"],
        required: true,
        description:
          "Report the missing agent or reviewer, then ask the user to configure it or revise the request.",
      },
    ];
  }

  const phases: WorkPhase[] = [];
  const designRequired =
    (decision.strategy === "supervised" || decision.strategy === "cross-check") &&
    request.managerCanPlan;
  if (designRequired) {
    phases.push({
      id: "design",
      actor: "manager",
      action: "design",
      inputs: ["instruction"],
      outputs: ["design"],
      required: true,
      description: "Write the implementation design, interfaces, edge cases and verification plan.",
    });
  }

  if (decision.strategy === "review-only") {
    phases.push({
      id: "dispatch",
      actor: "mcp",
      action: "mutual-check",
      tool: "execute_work_packet",
      inputs: [request.sourceTaskId ?? "sourceTaskId"],
      outputs: ["reviews"],
      required: true,
      description: "Run the selected reviewers on the existing source artifact.",
    });
  } else {
    phases.push({
      id: "dispatch",
      actor: "mcp",
      action: "dispatch",
      tool: "execute_work_packet",
      inputs: designRequired ? ["design"] : ["instruction"],
      outputs: decision.strategy === "cross-check" ? [artifactName, "reviews"] : [artifactName],
      required: true,
      description:
        "Create the task from the packet template and dispatch it to the selected worker.",
    });
  }

  phases.push({
    id: "verify",
    actor: "manager",
    action: "verify",
    tool: "get_task_result",
    inputs:
      decision.strategy === "cross-check" || decision.strategy === "review-only"
        ? [artifactName, "reviews"]
        : [artifactName],
    outputs: ["verification"],
    required: decision.strategy !== "dispatch",
    description:
      "Read the terminal task, inspect hashes and checks, then compile or run independent behavior tests.",
  });
  phases.push({
    id: "replan",
    actor: "manager",
    action: "replan",
    tool: "plan_work",
    inputs: ["verification"],
    outputs: ["new packet"],
    required: false,
    description: "If verification fails, request a new packet with the failure evidence.",
  });
  return phases;
}

function buildTaskTemplate(args: {
  request: WorkRequest;
  decision: WorkDecision;
  worker: WorkerSelection;
  reviewers: ReviewerSelection;
  sourceTask: TaskRecord | undefined;
  artifactName: string;
}): TaskSpec | undefined {
  const { request, decision, worker, reviewers, sourceTask, artifactName } = args;
  if (decision.strategy === "blocked") return undefined;

  const budget = request.budget ?? sourceTask?.spec.budget ?? defaultBudget;
  const timeoutMs = request.timeoutMs ?? sourceTask?.spec.timeoutMs ?? defaultTimeoutMs;
  if (decision.strategy === "review-only") {
    return taskSpecSchema.parse({
      version: 1,
      objective: request.instruction,
      allowedPaths: sourceTask?.spec.allowedPaths ?? [artifactName],
      excludedPaths: [],
      acceptance: ["mutual-check"],
      workerProfile: "mutual-check",
      mode: "mutual-check",
      reviewers: reviewers.names.map((agent) => ({ agent })),
      sourceTaskId: request.sourceTaskId,
      budget,
      timeoutMs,
      context: {
        summary:
          request.contextSummary ??
          sourceTask?.spec.context.summary ??
          `Review task ${String(request.sourceTaskId)}`,
        decisions: [],
        evidence: request.sourceTaskId
          ? [{ source: request.sourceTaskId, fact: "mutual-check source task" }]
          : [],
        openQuestions: [],
      },
    });
  }

  const workerName = worker.name;
  if (!workerName) {
    throw new Error("Planner selected a worker-required strategy without a worker");
  }
  const isFake = workerName === "fake";
  const designRequired =
    (decision.strategy === "supervised" || decision.strategy === "cross-check") &&
    request.managerCanPlan;
  return taskSpecSchema.parse({
    version: 1,
    objective: request.instruction,
    allowedPaths: [artifactName],
    excludedPaths: [],
    acceptance:
      decision.strategy === "cross-check"
        ? ["generated-file-scope", "mutual-check"]
        : ["generated-file-scope"],
    workerProfile: isFake ? "fake" : "file-generation",
    worker: { agent: workerName },
    mode: decision.strategy === "cross-check" ? "workflow" : "dispatch",
    reviewers:
      decision.strategy === "cross-check" ? reviewers.names.map((agent) => ({ agent })) : [],
    budget,
    timeoutMs,
    context: {
      summary:
        request.contextSummary ??
        (designRequired ? managerDesignPlaceholder : noManagerDesignSummary),
      decisions: [],
      evidence: [],
      openQuestions: [],
    },
  });
}

function buildManagerInstructions(
  request: WorkRequest,
  decision: WorkDecision,
  artifactName: string,
  worker: WorkerSelection,
  reviewers: ReviewerSelection,
  maxAttempts: number,
): string[] {
  const instructions = [
    "Use this packet as the routing decision; do not choose a different mode or worker yourself.",
  ];

  switch (decision.strategy) {
    case "blocked":
      instructions.push(
        `Stop and report the blocking reason: ${decision.reason}`,
        "Ask the user to configure the missing agent or reviewer, or revise the request.",
        "Do not fall back to fake or bypass the MCP dispatch boundary.",
      );
      return instructions;
    case "review-only":
      instructions.push(
        "Call execute_work_packet with the packet unchanged and a new idempotencyKey.",
        `The task reviews ${request.sourceTaskId ?? "the source task"}; no design is required.`,
        "After the task is terminal, read the checks and review JSON, and reject any blocker.",
      );
      break;
    case "dispatch":
      instructions.push(
        "Call execute_work_packet with the packet unchanged, an optional design/context, and a new idempotencyKey.",
        `The selected worker is ${worker.name ?? "unknown"}; the target artifact is ${artifactName}.`,
        "After the task is terminal, inspect the artifact and hashes; compile or test when the task requires it.",
      );
      break;
    case "supervised":
      if (request.managerCanPlan) {
        instructions.push(
          "Write a concise design first: inputs, outputs, edge cases, interfaces and verification steps.",
          "Then call execute_work_packet with the packet, design and a new idempotencyKey.",
        );
      } else {
        instructions.push(
          "Call execute_work_packet with the packet and a new idempotencyKey; no separate design phase is required.",
        );
      }
      instructions.push(
        `The selected worker is ${worker.name ?? "unknown"}; the target artifact is ${artifactName}.`,
        "After the task is terminal, call get_task_result and independently compile or run behavior tests.",
      );
      break;
    case "cross-check":
      if (request.managerCanPlan) {
        instructions.push(
          "Write a concise design first: inputs, outputs, edge cases, interfaces and verification steps.",
          "Then call execute_work_packet with the packet, design and a new idempotencyKey.",
        );
      } else {
        instructions.push("Call execute_work_packet with the packet and a new idempotencyKey.");
      }
      instructions.push(
        `MCP will run these reviewers: ${reviewers.names.join(", ") || "none"}.`,
        "After the task is terminal, call get_task_result and independently compile or run behavior tests.",
        "Manager verification is still required even when every harness reviewer passes.",
      );
      break;
  }

  instructions.push(
    "Poll get_task_result until the task reaches succeeded, failed, blocked or cancelled.",
    "Do not treat succeeded as compilation, behavior, numerical or performance proof.",
    `If verification fails, call plan_work again with the failure evidence; make at most ${String(maxAttempts)} attempt(s).`,
    "Use a new idempotencyKey for each new attempt; reuse the same key only when retransmitting the same submission.",
    "Do not publish or merge unless the user explicitly authorizes it.",
  );
  return instructions;
}

function buildStopConditions(decision: WorkDecision, maxAttempts: number): string[] {
  if (decision.strategy === "blocked") {
    return ["A required worker or reviewer is configured, or the request is revised."];
  }
  return [
    "The MCP task reaches succeeded, failed, blocked or cancelled.",
    `Verification fails after ${String(maxAttempts)} attempt(s).`,
    "A required worker or reviewer is unavailable.",
    "The task timeout or budget is reached.",
    "The artifact hash or required acceptance evidence is missing.",
  ];
}

function buildEscalation(
  decision: WorkDecision,
  worker: WorkerSelection,
  reviewers: ReviewerSelection,
): string[] {
  const items: string[] = [];
  if (decision.strategy === "blocked") {
    items.push(decision.reason);
    items.push("Configure HETEMCP_AGENTS or choose a different worker/reviewer.");
    items.push("Do not fall back to fake or bypass the MCP dispatch boundary.");
  }
  if (!worker.available && decision.strategy !== "review-only") {
    items.push(worker.reason);
  }
  if (decision.strategy === "supervised") {
    items.push(
      "Manager verification is the primary independent check; no harness reviewer was assigned.",
    );
  }
  if (decision.strategy === "dispatch") {
    items.push(
      "No independent reviewer was assigned; manager inspection is recommended before publication.",
    );
  }
  if (reviewers.names.length === 0 && decision.strategy === "cross-check") {
    items.push("No harness reviewer was selected; configure one before retrying cross-check.");
  }
  if (reviewers.names.length === 0 && decision.strategy === "review-only") {
    items.push("Configure at least one harness reviewer before retrying mutual-check.");
  }
  if (reviewers.reason.startsWith("Unavailable preferred reviewers")) {
    items.push(reviewers.reason);
  }
  items.push(
    "If the instruction is ambiguous, ask the user for a concrete artifact name and acceptance criteria.",
  );
  return items;
}

function defaultArtifactName(kind: WorkRequest["taskKind"]): string {
  switch (kind) {
    case "code":
      return "solution.cpp";
    case "document":
      return "notes.md";
    case "analysis":
      return "analysis.md";
    case "review":
      return "review-note.md";
    default:
      return "output.txt";
  }
}

function assertPacketConsistency(packet: WorkPacket, template: TaskSpec): void {
  const mode = normalizeExecutionMode(template.mode);
  if (packet.decision.taskMode && mode !== packet.decision.taskMode) {
    throw new DomainError(
      "PACKET_INVALID",
      "Task template mode does not match the packet decision",
    );
  }
  if (packet.roles.worker) {
    if (template.worker?.agent.toLowerCase() !== packet.roles.worker) {
      throw new DomainError(
        "PACKET_INVALID",
        "Task template worker does not match the packet roles",
      );
    }
  } else if (template.worker) {
    throw new DomainError(
      "PACKET_INVALID",
      "Task template has a worker but the packet assigns none",
    );
  }

  const templateReviewers = template.reviewers
    .map((reviewer) => reviewer.agent.toLowerCase())
    .sort();
  const roleReviewers = [...packet.roles.reviewers].sort();
  if (templateReviewers.join(",") !== roleReviewers.join(",")) {
    throw new DomainError(
      "PACKET_INVALID",
      "Task template reviewers do not match the packet roles",
    );
  }
  if (
    packet.decision.strategy === "review-only" &&
    template.sourceTaskId !== packet.request.sourceTaskId
  ) {
    throw new DomainError(
      "PACKET_INVALID",
      "Task template sourceTaskId does not match the packet request",
    );
  }
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
