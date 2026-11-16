import { describe, expect, it } from "vitest";

import {
  assertWorkPacketHash,
  buildTaskFromWorkPacket,
  computePlanHash,
  planWork,
} from "../../src/application/work-planner.js";
import type { CapabilityCatalog, TaskRecord } from "../../src/domain/schemas.js";
import { workRequestSchema } from "../../src/domain/work-packet.js";
import { createTaskSpec } from "../fixtures.js";

function catalog(
  names: string[],
  options: { fake?: boolean; unavailable?: string[] } = {},
): CapabilityCatalog {
  const agents = names.map((name) => ({
    name,
    kind: "fixture",
    profiles: ["file-generation"],
    available: !(options.unavailable ?? []).includes(name),
  }));
  if (options.fake) {
    agents.push({
      name: "fake",
      kind: "deterministic",
      profiles: ["fake"],
      available: true,
    });
  }
  return {
    defaultMode: "dispatch",
    modes: ["dispatch", "mutual-check", "workflow"],
    agents,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return workRequestSchema.parse({
    instruction: "Write a deterministic fixture task",
    ...overrides,
  });
}

function sourceTask(): TaskRecord {
  const spec = createTaskSpec({
    objective: "Existing artifact",
    allowedPaths: ["bubble.cpp"],
    excludedPaths: [],
    acceptance: ["generated-file-scope"],
    workerProfile: "file-generation",
    mode: "dispatch",
  });
  return {
    id: "00000000-0000-4000-8000-000000000099",
    idempotencyKey: "source-task",
    status: "succeeded",
    spec,
    revision: 3,
    attemptCount: 1,
    cancellationRequested: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    result: {
      status: "succeeded",
      summary: "Source artifact available",
      artifacts: [
        {
          kind: "source",
          uri: "file:///tmp/bubble.cpp",
          sha256: "a".repeat(64),
        },
      ],
      checks: [{ name: "generated-file-scope", outcome: "passed" }],
      usage: { inputTokens: 0, outputTokens: 0, costMicros: 0, measured: false },
    },
  };
}

describe("work planner", () => {
  it("dispatches low-risk bounded work directly", () => {
    const packet = planWork(
      request({
        taskKind: "document",
        risk: "low",
        ambiguity: "low",
      }),
      catalog(["claude", "codex", "deepseek"]),
    );

    expect(packet.decision.strategy).toBe("dispatch");
    expect(packet.decision.taskMode).toBe("dispatch");
    expect(packet.decision.matchedRule).toBe("low-risk-dispatch");
    expect(packet.roles.worker).toBe("deepseek");
    expect(packet.roles.reviewers).toEqual([]);
    expect(packet.taskTemplate?.workerProfile).toBe("file-generation");
    expect(packet.phases.some((phase) => phase.id === "design")).toBe(false);
    expect(packet.phases.find((phase) => phase.id === "verify")?.required).toBe(false);
  });

  it("uses supervised workflow for medium-risk code", () => {
    const packet = planWork(
      request({
        taskKind: "code",
        artifactName: "bubble.cpp",
      }),
      catalog(["claude", "codex", "deepseek"]),
    );

    expect(packet.decision.strategy).toBe("supervised");
    expect(packet.decision.taskMode).toBe("dispatch");
    expect(packet.decision.matchedRule).toBe("medium-risk-supervised");
    expect(packet.roles.worker).toBe("deepseek");
    expect(packet.roles.verifier).toBe("manager");
    expect(packet.phases.find((phase) => phase.id === "design")?.required).toBe(true);
    expect(packet.taskTemplate?.acceptance).toEqual(["generated-file-scope"]);

    const task = buildTaskFromWorkPacket(packet, "Use an iterative bubble sort.");
    expect(task.context.summary).toContain("Use an iterative bubble sort.");
    expect(task.worker?.agent).toBe("deepseek");
    expect(() => buildTaskFromWorkPacket(packet)).toThrow(/manager design/);
  });

  it("honors an explicit workflow with manager review", () => {
    const packet = planWork(
      request({
        taskKind: "code",
        artifactName: "bubble.cpp",
        requestedMode: "workflaw",
        reviewBy: "manager",
        preferredWorker: "deepseek",
      }),
      catalog(["claude", "codex", "deepseek"]),
    );

    expect(packet.decision.strategy).toBe("supervised");
    expect(packet.decision.matchedRule).toBe("explicit-workflow-manager-review");
    expect(packet.request.requestedMode).toBe("workflaw");
    expect(packet.roles.worker).toBe("deepseek");
    expect(packet.phases.map((phase) => phase.id)).toEqual([
      "design",
      "dispatch",
      "verify",
      "replan",
    ]);
  });

  it("uses harness cross-check when workflow requests reviewers", () => {
    const packet = planWork(
      request({
        taskKind: "code",
        artifactName: "bubble.cpp",
        requestedMode: "workflow",
        reviewBy: "harness",
        preferredWorker: "deepseek",
        preferredReviewers: ["codex"],
      }),
      catalog(["claude", "codex", "deepseek"]),
    );

    expect(packet.decision.strategy).toBe("cross-check");
    expect(packet.decision.taskMode).toBe("workflow");
    expect(packet.roles.reviewers).toEqual(["codex"]);
    expect(packet.taskTemplate?.mode).toBe("workflow");
    expect(packet.taskTemplate?.acceptance).toEqual(["generated-file-scope", "mutual-check"]);
  });

  it("uses cross-check for high-risk work with an available reviewer", () => {
    const packet = planWork(
      request({
        taskKind: "code",
        artifactName: "bubble.cpp",
        risk: "high",
      }),
      catalog(["claude", "codex", "deepseek"]),
    );

    expect(packet.decision.strategy).toBe("cross-check");
    expect(packet.decision.matchedRule).toBe("high-risk-cross-check");
    expect(packet.roles.reviewers.length).toBeGreaterThan(0);
  });

  it("creates a review-only packet for an existing artifact", () => {
    const existing = sourceTask();
    const packet = planWork(
      request({
        taskKind: "review",
        sourceTaskId: existing.id,
        instruction: "Review the existing bubble sort implementation",
      }),
      catalog(["claude", "codex"]),
      { sourceTask: existing },
    );

    expect(packet.decision.strategy).toBe("review-only");
    expect(packet.decision.taskMode).toBe("mutual-check");
    expect(packet.taskTemplate?.mode).toBe("mutual-check");
    expect(packet.taskTemplate?.sourceTaskId).toBe(existing.id);
    expect(packet.roles.worker).toBeUndefined();
    expect(packet.roles.reviewers.length).toBeGreaterThan(0);
  });

  it("lets the only available agent review an existing artifact", () => {
    const existing = sourceTask();
    const packet = planWork(
      request({
        taskKind: "review",
        sourceTaskId: existing.id,
        instruction: "Review the existing implementation",
      }),
      catalog(["claude"]),
      { sourceTask: existing },
    );

    expect(packet.decision.strategy).toBe("review-only");
    expect(packet.roles.worker).toBeUndefined();
    expect(packet.roles.reviewers).toEqual(["claude"]);
  });

  it("blocks contradictory or unverifiable requests", () => {
    expect(
      planWork(request({ taskKind: "review", instruction: "Review this" }), catalog(["claude"]))
        .decision.matchedRule,
    ).toBe("review-without-source");

    expect(
      planWork(
        request({
          taskKind: "code",
          requestedMode: "mutual-check",
        }),
        catalog(["claude"]),
      ).decision.matchedRule,
    ).toBe("mutual-check-without-source");

    expect(
      planWork(
        request({
          taskKind: "document",
          risk: "low",
          ambiguity: "low",
          requestedMode: "dispatch",
          preferredReviewers: ["codex"],
        }),
        catalog(["claude", "codex"]),
      ).decision.matchedRule,
    ).toBe("dispatch-with-reviewers");

    expect(
      planWork(
        request({
          taskKind: "code",
          preferredWorker: "codex",
        }),
        catalog(["claude"]),
      ).decision.strategy,
    ).toBe("blocked");

    expect(planWork(request({ taskKind: "code" }), catalog([])).decision.strategy).toBe("blocked");
  });

  it("allows an explicit fake worker only for dispatch", () => {
    const packet = planWork(
      request({
        taskKind: "document",
        risk: "low",
        ambiguity: "low",
        preferredWorker: "fake",
      }),
      catalog([], { fake: true }),
    );
    expect(packet.decision.strategy).toBe("dispatch");
    expect(packet.roles.worker).toBe("fake");
    expect(packet.taskTemplate?.workerProfile).toBe("fake");

    const supervised = planWork(
      request({
        taskKind: "code",
        preferredWorker: "fake",
      }),
      catalog([], { fake: true }),
    );
    expect(supervised.decision.strategy).toBe("blocked");
    expect(supervised.decision.matchedRule).toBe("fake-worker-supervised");
  });

  it("detects a tampered packet", () => {
    const packet = planWork(
      request({
        taskKind: "code",
        artifactName: "bubble.cpp",
      }),
      catalog(["claude", "codex", "deepseek"]),
    );
    expect(computePlanHash(packet)).toBe(packet.planHash);

    const tampered = structuredClone(packet);
    if (!tampered.taskTemplate) throw new Error("expected a task template");
    tampered.taskTemplate.objective = "Tampered objective";
    expect(() => assertWorkPacketHash(tampered)).toThrow(/hash mismatch/);
    expect(() => buildTaskFromWorkPacket(tampered, "design")).toThrow(/hash mismatch/);
  });
});
