import type { AttemptResult, TaskSpec } from "../../domain/schemas.js";

export interface ProviderExecution {
  taskId: string;
  attemptId: string;
  spec: TaskSpec;
  signal: AbortSignal;
}

export interface ModelProvider {
  readonly name: string;
  execute(execution: ProviderExecution): Promise<AttemptResult>;
}
