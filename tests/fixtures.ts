import { taskSpecSchema, type SubmitTaskInput, type TaskSpec } from "../src/domain/schemas.js";

const baseTask = {
  version: 1 as const,
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
};

export function createTaskSpec(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return taskSpecSchema.parse({ ...baseTask, ...overrides });
}

export function createTaskInput(overrides: Partial<SubmitTaskInput> = {}): SubmitTaskInput {
  return {
    idempotencyKey: "test-task-1",
    task: createTaskSpec(),
    ...overrides,
  };
}
