import { DomainError } from "../../domain/errors.js";
import { taskRecordSchema, type TaskRecord } from "../../domain/schemas.js";
import type { TaskRepository } from "../../application/ports/task-repository.js";

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
    if (!current) throw new DomainError("TASK_NOT_FOUND", `Task ${task.id} was not found`);
    if (current.revision !== expectedRevision) {
      throw new DomainError(
        "REVISION_CONFLICT",
        `Task ${task.id} revision changed from ${String(expectedRevision)} to ${String(current.revision)}`,
        true,
      );
    }

    const updated = taskRecordSchema.parse({ ...task, revision: expectedRevision + 1 });
    this.#tasks.set(updated.id, this.clone(updated));
    return Promise.resolve(this.clone(updated));
  }

  private findRequired(id: string): TaskRecord {
    const task = this.#tasks.get(id);
    if (!task) throw new DomainError("TASK_NOT_FOUND", `Task ${id} was not found`);
    return this.clone(task);
  }

  private clone(task: TaskRecord): TaskRecord {
    return structuredClone(task);
  }
}
