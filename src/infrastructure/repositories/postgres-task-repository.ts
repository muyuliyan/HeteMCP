import type { TaskClaim, TaskRepository } from "../../application/ports/task-repository.js";
import { DomainError } from "../../domain/errors.js";
import { taskRecordSchema, type TaskRecord } from "../../domain/schemas.js";
import { transitionTask } from "../../domain/task.js";
import type { SqlDatabase, SqlExecutor, SqlRow } from "../postgres/database.js";

interface RecordRow extends SqlRow {
  record: unknown;
}

export class PostgresTaskRepository implements TaskRepository {
  public constructor(private readonly database: SqlDatabase) {}

  public async create(task: TaskRecord): Promise<TaskRecord> {
    const result = await this.database.query<RecordRow>(
      `
        INSERT INTO tasks (
          id, idempotency_key, status, revision, lease_owner, lease_expires_at,
          created_at, updated_at, record
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
        ON CONFLICT (idempotency_key) DO UPDATE
          SET idempotency_key = EXCLUDED.idempotency_key
        RETURNING record
      `,
      this.toParameters(task),
    );
    return this.parseRequired(result.rows[0]);
  }

  public async findById(id: string): Promise<TaskRecord | undefined> {
    const result = await this.database.query<RecordRow>("SELECT record FROM tasks WHERE id = $1", [
      id,
    ]);
    return this.parseOptional(result.rows[0]);
  }

  public async findByIdempotencyKey(idempotencyKey: string): Promise<TaskRecord | undefined> {
    const result = await this.database.query<RecordRow>(
      "SELECT record FROM tasks WHERE idempotency_key = $1",
      [idempotencyKey],
    );
    return this.parseOptional(result.rows[0]);
  }

  public update(task: TaskRecord, expectedRevision: number): Promise<TaskRecord> {
    return this.updateWith(this.database, task, expectedRevision);
  }

  public claimById(taskId: string, claim: TaskClaim): Promise<TaskRecord | undefined> {
    return this.database.transaction(async (executor) => {
      const result = await executor.query<RecordRow>(
        "SELECT record FROM tasks WHERE id = $1 AND status = 'queued' FOR UPDATE SKIP LOCKED",
        [taskId],
      );
      return this.claimSelected(executor, result.rows[0], claim);
    });
  }

  public claimNext(claim: TaskClaim): Promise<TaskRecord | undefined> {
    return this.database.transaction(async (executor) => {
      const result = await executor.query<RecordRow>(`
        SELECT record
        FROM tasks
        WHERE status = 'queued'
        ORDER BY created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `);
      return this.claimSelected(executor, result.rows[0], claim);
    });
  }

  public async renewLease(
    taskId: string,
    attemptId: string,
    workerId: string,
    leaseExpiresAt: string,
  ): Promise<boolean> {
    const result = await this.database.query<SqlRow>(
      `
        UPDATE tasks
        SET lease_expires_at = $4::timestamptz,
            record = jsonb_set(record, '{leaseExpiresAt}', to_jsonb($5::text), true)
        WHERE id = $1
          AND status = 'running'
          AND record->>'attemptId' = $2
          AND lease_owner = $3
      `,
      [taskId, attemptId, workerId, leaseExpiresAt, leaseExpiresAt],
    );
    return result.rowCount === 1;
  }

  public requeueExpired(now: string): Promise<number> {
    return this.database.transaction(async (executor) => {
      const result = await executor.query<RecordRow>(
        `
          SELECT record
          FROM tasks
          WHERE status = 'running' AND lease_expires_at <= $1
          FOR UPDATE SKIP LOCKED
        `,
        [now],
      );

      for (const row of result.rows) {
        const task = this.parseRequired(row);
        const recovered = structuredClone(task);
        delete recovered.leaseOwner;
        delete recovered.leaseExpiresAt;
        const queued = transitionTask(recovered, "queued", now);
        await this.updateWith(executor, queued, task.revision);
      }
      return result.rows.length;
    });
  }

  private async claimSelected(
    executor: SqlExecutor,
    row: RecordRow | undefined,
    claim: TaskClaim,
  ): Promise<TaskRecord | undefined> {
    if (!row) return undefined;
    const task = this.parseRequired(row);
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
    return this.updateWith(executor, running, task.revision);
  }

  private async updateWith(
    executor: SqlExecutor,
    task: TaskRecord,
    expectedRevision: number,
  ): Promise<TaskRecord> {
    const updated = taskRecordSchema.parse({ ...task, revision: expectedRevision + 1 });
    const result = await executor.query<RecordRow>(
      `
        UPDATE tasks
        SET status = $2,
            revision = $3,
            lease_owner = $4,
            lease_expires_at = $5,
            updated_at = $6,
            record = $7::jsonb
        WHERE id = $1 AND revision = $8
        RETURNING record
      `,
      [
        updated.id,
        updated.status,
        updated.revision,
        updated.leaseOwner ?? null,
        updated.leaseExpiresAt ?? null,
        updated.updatedAt,
        JSON.stringify(updated),
        expectedRevision,
      ],
    );
    if (result.rowCount === 0) {
      const exists = await executor.query<SqlRow>("SELECT 1 FROM tasks WHERE id = $1", [task.id]);
      if (exists.rowCount === 0) {
        throw new DomainError("TASK_NOT_FOUND", `Task ${task.id} was not found`);
      }
      throw new DomainError(
        "REVISION_CONFLICT",
        `Task ${task.id} revision changed from ${String(expectedRevision)}`,
        true,
      );
    }
    return this.parseRequired(result.rows[0]);
  }

  private toParameters(task: TaskRecord): readonly unknown[] {
    return [
      task.id,
      task.idempotencyKey,
      task.status,
      task.revision,
      task.leaseOwner ?? null,
      task.leaseExpiresAt ?? null,
      task.createdAt,
      task.updatedAt,
      JSON.stringify(task),
    ];
  }

  private parseOptional(row: RecordRow | undefined): TaskRecord | undefined {
    return row ? this.parseRequired(row) : undefined;
  }

  private parseRequired(row: RecordRow | undefined): TaskRecord {
    if (!row) throw new Error("PostgreSQL did not return the expected task record");
    const value: unknown =
      typeof row.record === "string" ? (JSON.parse(row.record) as unknown) : row.record;
    return taskRecordSchema.parse(value);
  }
}
