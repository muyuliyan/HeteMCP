export type DomainErrorCode =
  "TASK_NOT_FOUND" | "INVALID_TRANSITION" | "REVISION_CONFLICT" | "PROVIDER_FAILURE";

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
