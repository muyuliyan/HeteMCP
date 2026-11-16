export type DomainErrorCode =
  | "TASK_NOT_FOUND"
  | "INVALID_TRANSITION"
  | "LEASE_LOST"
  | "REVISION_CONFLICT"
  | "PROVIDER_FAILURE"
  | "SOURCE_TASK_REQUIRED"
  | "SOURCE_TASK_NO_ARTIFACTS"
  | "AGENT_NOT_FOUND"
  | "AGENT_UNAVAILABLE"
  | "INVALID_MODE";

export class DomainError extends Error {
  public constructor(
    public readonly code: DomainErrorCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
