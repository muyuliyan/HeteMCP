import { DomainError } from "./errors.js";
import type { TaskRecord, TaskStatus } from "./schemas.js";

const allowedTransitions: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  queued: ["running", "cancelled"],
  running: ["queued", "blocked", "reviewing", "failed", "cancelled"],
  blocked: ["queued", "cancelled"],
  reviewing: ["succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export function isTerminalStatus(status: TaskStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

export function transitionTask(
  task: TaskRecord,
  nextStatus: TaskStatus,
  updatedAt: string,
): TaskRecord {
  if (!allowedTransitions[task.status].includes(nextStatus)) {
    throw new DomainError(
      "INVALID_TRANSITION",
      `Task ${task.id} cannot transition from ${task.status} to ${nextStatus}`,
    );
  }

  return { ...task, status: nextStatus, updatedAt };
}
