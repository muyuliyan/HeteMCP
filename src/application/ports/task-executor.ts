import type { AttemptResult, TaskSpec } from "../../domain/schemas.js";

export interface TaskExecution {
  taskId: string;
  attemptId: string;
  spec: TaskSpec;
  signal: AbortSignal;
}

// An execution service owns artifact collection and independent acceptance.
// An AgentHarness alone cannot implement this contract by claiming success.
export interface TaskExecutor {
  readonly name: string;
  execute(execution: TaskExecution): Promise<AttemptResult>;
}
