import { describe, expect, it } from "vitest";

import { DomainError } from "../../src/domain/errors.js";
import { type TaskRecord } from "../../src/domain/schemas.js";
import { transitionTask } from "../../src/domain/task.js";
import { createTaskInput } from "../fixtures.js";

function queuedTask(): TaskRecord {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    idempotencyKey: "transition-test",
    status: "queued",
    spec: createTaskInput().task,
    revision: 0,
    attemptCount: 0,
    cancellationRequested: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("task state machine", () => {
  it("allows a queued task to start", () => {
    const running = transitionTask(queuedTask(), "running", "2026-01-01T00:00:01.000Z");
    expect(running.status).toBe("running");
  });

  it("rejects transitions that skip deterministic review", () => {
    expect(() => transitionTask(queuedTask(), "succeeded", "2026-01-01T00:00:01.000Z")).toThrow(
      DomainError,
    );
  });
});
