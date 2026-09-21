import type { TaskRecord } from "../../domain/schemas.js";

export interface TaskClaim {
  attemptId: string;
  workerId: string;
  provider: string;
  claimedAt: string;
  leaseExpiresAt: string;
}

export interface TaskRepository {
  create(task: TaskRecord): Promise<TaskRecord>;
  findById(id: string): Promise<TaskRecord | undefined>;
  findByIdempotencyKey(idempotencyKey: string): Promise<TaskRecord | undefined>;
  update(task: TaskRecord, expectedRevision: number): Promise<TaskRecord>;
  claimById(taskId: string, claim: TaskClaim): Promise<TaskRecord | undefined>;
  claimNext(claim: TaskClaim): Promise<TaskRecord | undefined>;
  renewLease(
    taskId: string,
    attemptId: string,
    workerId: string,
    leaseExpiresAt: string,
  ): Promise<boolean>;
  requeueExpired(now: string): Promise<number>;
}
