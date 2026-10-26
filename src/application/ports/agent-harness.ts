export interface HarnessExecution {
  taskId: string;
  attemptId: string;
  workspacePath: string;
  prompt: string;
  timeoutMs: number;
  signal: AbortSignal;
}

export type HarnessErrorCode =
  "START_FAILED" | "PROTOCOL_ERROR" | "PROCESS_FAILED" | "CANCELLED" | "TIMEOUT" | "OUTPUT_LIMIT";

// Completion describes the agent turn, never acceptance of its repository changes.
export interface HarnessOutcome {
  status: "completed" | "failed";
  sessionId?: string;
  exitCode: number | null;
  error?: { code: HarnessErrorCode; retryable: boolean; message: string };
}

export interface AgentHarness {
  readonly kind: string;
  execute(input: HarnessExecution): Promise<HarnessOutcome>;
}
