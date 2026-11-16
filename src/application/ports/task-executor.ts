import type {
  AttemptResult,
  CapabilityCatalog,
  TaskRecord,
  TaskSpec,
} from "../../domain/schemas.js";

export interface TaskExecution {
  taskId: string;
  attemptId: string;
  spec: TaskSpec;
  signal: AbortSignal;
  // Resolved by the orchestrator only for standalone mutual-check tasks.
  sourceTask?: TaskRecord;
}

// An execution service owns artifact collection and independent acceptance.
// An AgentHarness alone cannot implement this contract by claiming success.
export interface TaskExecutor {
  readonly name: string;
  execute(execution: TaskExecution): Promise<AttemptResult>;
  describe?(): CapabilityCatalog;
}
