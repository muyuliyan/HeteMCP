import type { TaskRecord } from "../../domain/schemas.js";

export interface TaskRepository {
  create(task: TaskRecord): Promise<TaskRecord>;
  findById(id: string): Promise<TaskRecord | undefined>;
  findByIdempotencyKey(idempotencyKey: string): Promise<TaskRecord | undefined>;
  update(task: TaskRecord, expectedRevision: number): Promise<TaskRecord>;
}
