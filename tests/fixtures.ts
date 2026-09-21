import type { SubmitTaskInput } from "../src/domain/schemas.js";

export function createTaskInput(overrides: Partial<SubmitTaskInput> = {}): SubmitTaskInput {
  return {
    idempotencyKey: "test-task-1",
    task: {
      version: 1,
      objective: "Implement a deterministic test task",
      allowedPaths: ["src/**"],
      excludedPaths: ["src/secrets/**"],
      acceptance: ["Unit tests pass"],
      workerProfile: "fake",
      budget: {
        maxInputTokens: 1_000,
        maxOutputTokens: 1_000,
        maxCostMicros: 0,
      },
      timeoutMs: 5_000,
      context: {
        summary: "Test context",
        decisions: [],
        evidence: [],
        openQuestions: [],
      },
    },
    ...overrides,
  };
}
