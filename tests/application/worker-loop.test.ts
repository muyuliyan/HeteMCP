import { describe, expect, it } from "vitest";

import { Orchestrator } from "../../src/application/orchestrator.js";
import { WorkerLoop } from "../../src/application/worker-loop.js";
import { FakeProvider } from "../../src/infrastructure/providers/fake-provider.js";
import { InMemoryTaskRepository } from "../../src/infrastructure/repositories/in-memory-task-repository.js";
import { createTaskInput } from "../fixtures.js";

describe("WorkerLoop", () => {
  it("drains queued tasks left by a previous process", async () => {
    const orchestrator = new Orchestrator(new InMemoryTaskRepository(), new FakeProvider(), {
      workerId: "recovery-worker",
    });
    const first = await orchestrator.createTask(createTaskInput());
    const second = await orchestrator.createTask(
      createTaskInput({ idempotencyKey: "test-task-2" }),
    );
    const loop = new WorkerLoop(orchestrator);

    await expect(loop.drain()).resolves.toBe(2);
    await expect(orchestrator.getTask(first.id)).resolves.toMatchObject({ status: "succeeded" });
    await expect(orchestrator.getTask(second.id)).resolves.toMatchObject({ status: "succeeded" });
  });

  it("coalesces overlapping drain requests", async () => {
    const orchestrator = new Orchestrator(new InMemoryTaskRepository(), new FakeProvider());
    await orchestrator.createTask(createTaskInput());
    const loop = new WorkerLoop(orchestrator);
    const first = loop.drain();
    const second = loop.drain();
    expect(second).toBe(first);
    await expect(first).resolves.toBe(1);
  });
});
