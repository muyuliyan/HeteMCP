import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TaskClaim, TaskRepository } from "../../src/application/ports/task-repository.js";
import type { DomainError } from "../../src/domain/errors.js";
import { taskRecordSchema, type TaskRecord } from "../../src/domain/schemas.js";
import { runMigrations } from "../../src/infrastructure/postgres/migrations.js";
import { InMemoryTaskRepository } from "../../src/infrastructure/repositories/in-memory-task-repository.js";
import { PostgresTaskRepository } from "../../src/infrastructure/repositories/postgres-task-repository.js";
import { createTaskInput } from "../fixtures.js";
import { PGliteDatabase } from "../helpers/pglite-database.js";

interface RepositoryHarness {
  repository: TaskRepository;
  close(): Promise<void>;
}

const factories: {
  name: string;
  create: () => Promise<RepositoryHarness>;
}[] = [
  {
    name: "in-memory",
    create: () =>
      Promise.resolve({
        repository: new InMemoryTaskRepository(),
        close: () => Promise.resolve(),
      }),
  },
  {
    name: "PostgreSQL",
    create: async () => {
      const database = new PGliteDatabase();
      await database.ready();
      await runMigrations(database);
      return {
        repository: new PostgresTaskRepository(database),
        close: () => database.close(),
      };
    },
  },
];

function createRecord(createdAt = "2026-01-01T00:00:00.000Z"): TaskRecord {
  return taskRecordSchema.parse({
    id: randomUUID(),
    idempotencyKey: randomUUID(),
    status: "queued",
    spec: createTaskInput().task,
    revision: 0,
    attemptCount: 0,
    cancellationRequested: false,
    createdAt,
    updatedAt: createdAt,
  });
}

function createClaim(overrides: Partial<TaskClaim> = {}): TaskClaim {
  return {
    attemptId: randomUUID(),
    workerId: "worker-1",
    provider: "fake",
    claimedAt: "2026-01-01T00:00:01.000Z",
    leaseExpiresAt: "2026-01-01T00:01:01.000Z",
    ...overrides,
  };
}

describe.each(factories)("$name task repository", ({ create: createHarness }) => {
  let harness: RepositoryHarness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  it("returns the original task for an idempotent create", async () => {
    const first = createRecord();
    const duplicate = createRecord();
    duplicate.idempotencyKey = first.idempotencyKey;

    const created = await harness.repository.create(first);
    const repeated = await harness.repository.create(duplicate);
    expect(repeated.id).toBe(created.id);
  });

  it("allows only one worker to claim a queued task", async () => {
    const task = await harness.repository.create(createRecord());
    const claim = createClaim();
    const claimed = await harness.repository.claimById(task.id, claim);
    const competing = await harness.repository.claimById(task.id, createClaim());

    expect(claimed).toMatchObject({
      status: "running",
      attemptCount: 1,
      leaseOwner: claim.workerId,
      attemptId: claim.attemptId,
    });
    expect(competing).toBeUndefined();
    await expect(
      harness.repository.renewLease(
        task.id,
        claim.attemptId,
        "other-worker",
        "2026-01-01T00:02:00.000Z",
      ),
    ).resolves.toBe(false);
    await expect(
      harness.repository.renewLease(
        task.id,
        claim.attemptId,
        claim.workerId,
        "2026-01-01T00:02:00.000Z",
      ),
    ).resolves.toBe(true);
  });

  it("requeues an expired lease and invalidates the old revision", async () => {
    const task = await harness.repository.create(createRecord());
    const claimed = await harness.repository.claimById(
      task.id,
      createClaim({ leaseExpiresAt: "2026-01-01T00:00:02.000Z" }),
    );
    expect(claimed).toBeDefined();

    await expect(harness.repository.requeueExpired("2026-01-01T00:00:03.000Z")).resolves.toBe(1);
    const recovered = await harness.repository.findById(task.id);
    expect(recovered).toMatchObject({ status: "queued", attemptCount: 1, revision: 2 });
    expect(recovered?.leaseOwner).toBeUndefined();

    if (!claimed) throw new Error("Expected task claim");
    await expect(harness.repository.update(claimed, claimed.revision)).rejects.toMatchObject({
      code: "REVISION_CONFLICT",
    } satisfies Partial<DomainError>);

    const reclaimed = await harness.repository.claimById(task.id, createClaim());
    expect(reclaimed).toMatchObject({ status: "running", attemptCount: 2, revision: 3 });
  });

  it("claims queued work in creation order", async () => {
    const later = await harness.repository.create(createRecord("2026-01-01T00:00:02.000Z"));
    const earlier = await harness.repository.create(createRecord("2026-01-01T00:00:01.000Z"));
    const claimed = await harness.repository.claimNext(createClaim());
    expect(claimed?.id).toBe(earlier.id);
    expect(claimed?.id).not.toBe(later.id);
  });
});
