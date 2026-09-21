import { DomainError } from "../../domain/errors.js";
import { taskRecordSchema, type TaskRecord } from "../../domain/schemas.js";
import { transitionTask } from "../../domain/task.js";
import type { TaskClaim, TaskRepository } from "../../application/ports/task-repository.js";

export class InMemoryTaskRepository implements TaskRepository {
  readonly #tasks = new Map<string, TaskRecord>();
  readonly #idempotencyIndex = new Map<string, string>();

  public create(task: TaskRecord): Promise<TaskRecord> {
    const existingId = this.#idempotencyIndex.get(task.idempotencyKey);
    if (existingId) return Promise.resolve(this.findRequired(existingId));

    const stored = this.clone(taskRecordSchema.parse(task));
    this.#tasks.set(stored.id, stored);
    this.#idempotencyIndex.set(stored.idempotencyKey, stored.id);
    return Promise.resolve(this.clone(stored));
  }

  public findById(id: string): Promise<TaskRecord | undefined> {
    const task = this.#tasks.get(id);
    return Promise.resolve(task ? this.clone(task) : undefined);
  }

  public async findByIdempotencyKey(idempotencyKey: string): Promise<TaskRecord | undefined> {
    const id = this.#idempotencyIndex.get(idempotencyKey);
    return id ? this.findById(id) : undefined;
  }

  public update(task: TaskRecord, expectedRevision: number): Promise<TaskRecord> {
    const current = this.#tasks.get(task.id);
    if (!current) {
      return Promise.reject(new DomainError("TASK_NOT_FOUND", `Task ${task.id} was not found`));
    }
    if (current.revision !== expectedRevision) {
      return Promise.reject(
        new DomainError(
          "REVISION_CONFLICT",
          `Task ${task.id} revision changed from ${String(expectedRevision)} to ${String(current.revision)}`,
          true,
        ),
      );
    }

    const updated = taskRecordSchema.parse({ ...task, revision: expectedRevision + 1 });
    this.#tasks.set(updated.id, this.clone(updated));
    return Promise.resolve(this.clone(updated));
  }

  public claimById(taskId: string, claim: TaskClaim): Promise<TaskRecord | undefined> {
    const task = this.#tasks.get(taskId);
    return Promise.resolve(task?.status === "queued" ? this.claim(task, claim) : undefined);
  }

  public claimNext(claim: TaskClaim): Promise<TaskRecord | undefined> {
    const task = [...this.#tasks.values()]
      .filter((candidate) => candidate.status === "queued")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
    return Promise.resolve(task ? this.claim(task, claim) : undefined);
  }

  public renewLease(
    taskId: string,
    attemptId: string,
    workerId: string,
    leaseExpiresAt: string,
  ): Promise<boolean> {
    const task = this.#tasks.get(taskId);
    if (
      task?.status !== "running" ||
      task.attemptId !== attemptId ||
      task.leaseOwner !== workerId
    ) {
      return Promise.resolve(false);
    }

    this.#tasks.set(task.id, this.clone({ ...task, leaseExpiresAt }));
    return Promise.resolve(true);
  }

  public requeueExpired(now: string): Promise<number> {
    let count = 0;
    for (const task of this.#tasks.values()) {
      if (task.status !== "running" || !task.leaseExpiresAt || task.leaseExpiresAt > now) continue;

      const recovered = this.clone(task);
      delete recovered.leaseOwner;
      delete recovered.leaseExpiresAt;
      const queued = transitionTask(recovered, "queued", now);
      this.#tasks.set(task.id, { ...queued, revision: task.revision + 1 });
      count += 1;
    }
    return Promise.resolve(count);
  }

  private findRequired(id: string): TaskRecord {
    const task = this.#tasks.get(id);
    if (!task) throw new DomainError("TASK_NOT_FOUND", `Task ${id} was not found`);
    return this.clone(task);
  }

  private claim(task: TaskRecord, claim: TaskClaim): TaskRecord {
    const running = transitionTask(
      {
        ...task,
        attemptId: claim.attemptId,
        provider: claim.provider,
        workerId: claim.workerId,
        attemptCount: task.attemptCount + 1,
        leaseOwner: claim.workerId,
        leaseExpiresAt: claim.leaseExpiresAt,
      },
      "running",
      claim.claimedAt,
    );
    const claimed = taskRecordSchema.parse({ ...running, revision: task.revision + 1 });
    this.#tasks.set(claimed.id, this.clone(claimed));
    return this.clone(claimed);
  }

  private clone(task: TaskRecord): TaskRecord {
    return structuredClone(task);
  }
}
