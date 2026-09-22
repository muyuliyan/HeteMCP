import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { TaskClaim } from "../../src/application/ports/task-repository.js";
import { taskRecordSchema, type TaskRecord } from "../../src/domain/schemas.js";
import { PgDatabase } from "../../src/infrastructure/postgres/database.js";
import { runMigrations } from "../../src/infrastructure/postgres/migrations.js";
import { PostgresTaskRepository } from "../../src/infrastructure/repositories/postgres-task-repository.js";
import { createTaskInput } from "../fixtures.js";

const connectionString = process.env.HETEMCP_INTEGRATION_DATABASE_URL;
if (!connectionString) {
  throw new Error("HETEMCP_INTEGRATION_DATABASE_URL is required for PostgreSQL integration tests");
}

const primaryDatabase = new PgDatabase({ connectionString, max: 4 });
const competingDatabase = new PgDatabase({ connectionString, max: 4 });
const databases = [primaryDatabase, competingDatabase];
const primaryRepository = new PostgresTaskRepository(primaryDatabase);
const competingRepository = new PostgresTaskRepository(competingDatabase);

function createTask(): TaskRecord {
  const timestamp = new Date().toISOString();
  return taskRecordSchema.parse({
    id: randomUUID(),
    idempotencyKey: randomUUID(),
    status: "queued",
    spec: createTaskInput().task,
    revision: 0,
    attemptCount: 0,
    cancellationRequested: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

function createClaim(workerId: string, leaseExpiresAt: string): TaskClaim {
  return {
    attemptId: randomUUID(),
    workerId,
    provider: "integration-fake",
    claimedAt: new Date().toISOString(),
    leaseExpiresAt,
  };
}

describe("PostgreSQL integration", () => {
  beforeAll(async () => {
    await Promise.all(databases.map((database) => runMigrations(database)));
  });

  beforeEach(async () => {
    await primaryDatabase.query("TRUNCATE TABLE tasks");
  });

  afterAll(async () => {
    await Promise.all(databases.map((database) => database.close()));
  });

  it("serializes concurrent claims across independent pools", async () => {
    const task = await primaryRepository.create(createTask());
    const leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();

    const claims = await Promise.all([
      primaryRepository.claimById(task.id, createClaim("worker-a", leaseExpiresAt)),
      competingRepository.claimById(task.id, createClaim("worker-b", leaseExpiresAt)),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)).toMatchObject({ status: "running", attemptCount: 1 });
  });

  it("reconnects after the active PostgreSQL connection is terminated", async () => {
    const reconnectingDatabase = new PgDatabase({ connectionString, max: 1 });
    try {
      await expect(
        reconnectingDatabase.query("SELECT pg_terminate_backend(pg_backend_pid())"),
      ).rejects.toThrow();
      await expect(
        reconnectingDatabase.query<{ value: number }>("SELECT 1 AS value"),
      ).resolves.toMatchObject({ rows: [{ value: 1 }] });
    } finally {
      await reconnectingDatabase.close();
    }
  });

  it("recovers an expired lease after a repository restart", async () => {
    const originalDatabase = new PgDatabase({ connectionString, max: 1 });
    const originalRepository = new PostgresTaskRepository(originalDatabase);
    const task = await originalRepository.create(createTask());
    await originalRepository.claimById(
      task.id,
      createClaim("lost-worker", new Date(Date.now() - 1_000).toISOString()),
    );
    await originalDatabase.close();

    const restartedDatabase = new PgDatabase({ connectionString, max: 1 });
    try {
      const recoveredRepository = new PostgresTaskRepository(restartedDatabase);
      await expect(recoveredRepository.requeueExpired(new Date().toISOString())).resolves.toBe(1);
      await expect(recoveredRepository.findById(task.id)).resolves.toMatchObject({
        status: "queued",
        attemptCount: 1,
      });
    } finally {
      await restartedDatabase.close();
    }
  });

  it("keeps a heartbeating task leased until the renewed deadline", async () => {
    const task = await primaryRepository.create(createTask());
    const claim = createClaim("steady-worker", "2026-01-01T00:00:02.000Z");
    await primaryRepository.claimById(task.id, claim);

    await expect(
      primaryRepository.renewLease(
        task.id,
        claim.attemptId,
        claim.workerId,
        "2026-01-01T00:00:10.000Z",
      ),
    ).resolves.toBe(true);
    await expect(primaryRepository.requeueExpired("2026-01-01T00:00:03.000Z")).resolves.toBe(0);
    await expect(primaryRepository.findById(task.id)).resolves.toMatchObject({
      status: "running",
      leaseExpiresAt: "2026-01-01T00:00:10.000Z",
    });
    await expect(primaryRepository.requeueExpired("2026-01-01T00:00:11.000Z")).resolves.toBe(1);
  });

  it("installs the queue indexes and one migration version", async () => {
    const indexes = await primaryDatabase.query<{ indexname: string }>(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'tasks'
    `);
    expect(indexes.rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining(["tasks_queue_order_idx", "tasks_expired_lease_idx"]),
    );

    const versions = await primaryDatabase.query<{ version: number }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    expect(versions.rows).toEqual([{ version: 1 }]);
  });

  it("uses the partial indexes for queue and lease scans", async () => {
    await primaryDatabase.transaction(async (executor) => {
      await executor.query("SET LOCAL enable_seqscan = off");
      const queuePlan = await executor.query<{ "QUERY PLAN": unknown }>(`
        EXPLAIN (FORMAT JSON)
        SELECT id
        FROM tasks
        WHERE status = 'queued'
        ORDER BY created_at, id
        LIMIT 1
      `);
      const leasePlan = await executor.query<{ "QUERY PLAN": unknown }>(`
        EXPLAIN (FORMAT JSON)
        SELECT id
        FROM tasks
        WHERE status = 'running' AND lease_expires_at <= now()
      `);

      expect(JSON.stringify(queuePlan.rows)).toContain("tasks_queue_order_idx");
      expect(JSON.stringify(leasePlan.rows)).toContain("tasks_expired_lease_idx");
    });
  });
});
