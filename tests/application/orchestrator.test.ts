import { describe, expect, it } from "vitest";

import { Orchestrator } from "../../src/application/orchestrator.js";
import type {
  ModelProvider,
  ProviderExecution,
} from "../../src/application/ports/model-provider.js";
import type { AttemptResult } from "../../src/domain/schemas.js";
import { FakeProvider } from "../../src/infrastructure/providers/fake-provider.js";
import { InMemoryTaskRepository } from "../../src/infrastructure/repositories/in-memory-task-repository.js";
import { createTaskInput } from "../fixtures.js";

const ids = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
];

function createOrchestrator(provider: ModelProvider = new FakeProvider()): Orchestrator {
  let index = 0;
  return new Orchestrator(new InMemoryTaskRepository(), provider, {
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    createId: () => ids[index++] ?? crypto.randomUUID(),
    workerId: "test-worker",
  });
}

class AbortableProvider implements ModelProvider {
  public readonly name = "abortable";
  public readonly started: Promise<void>;
  readonly #markStarted: () => void;

  public constructor() {
    let resolveStarted: (() => void) | undefined;
    this.started = new Promise((resolve) => {
      resolveStarted = resolve;
    });
    this.#markStarted = () => resolveStarted?.();
  }

  public execute({ signal }: ProviderExecution): Promise<AttemptResult> {
    this.#markStarted();
    return new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }
}

class CountingProvider implements ModelProvider {
  public readonly name = "counting";
  public callCount = 0;
  readonly #delegate = new FakeProvider();

  public execute(execution: ProviderExecution): Promise<AttemptResult> {
    this.callCount += 1;
    return this.#delegate.execute(execution);
  }
}

class IncompleteProvider implements ModelProvider {
  public readonly name = "incomplete";

  public execute({ taskId, attemptId }: ProviderExecution): Promise<AttemptResult> {
    return Promise.resolve({
      status: "succeeded",
      summary: "Claimed success without acceptance evidence",
      artifacts: [{ kind: "log", uri: `memory://${taskId}/${attemptId}` }],
      checks: [],
      usage: { inputTokens: 1, outputTokens: 1, costMicros: 0 },
    });
  }
}

class TimeoutProvider implements ModelProvider {
  public readonly name = "timeout";

  public execute({ signal }: ProviderExecution): Promise<AttemptResult> {
    return new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("provider aborted")), { once: true });
    });
  }
}

class ControlledProvider implements ModelProvider {
  public readonly name = "controlled";
  public readonly started: Promise<void>;
  readonly #markStarted: () => void;
  readonly #result: Promise<AttemptResult>;
  readonly #complete: (result: AttemptResult) => void;

  public constructor() {
    let markStarted: (() => void) | undefined;
    let complete: ((result: AttemptResult) => void) | undefined;
    this.started = new Promise((resolve) => {
      markStarted = resolve;
    });
    this.#result = new Promise((resolve) => {
      complete = resolve;
    });
    this.#markStarted = () => markStarted?.();
    this.#complete = (result) => complete?.(result);
  }

  public execute(): Promise<AttemptResult> {
    this.#markStarted();
    return this.#result;
  }

  public complete(result: AttemptResult): void {
    this.#complete(result);
  }
}

describe("Orchestrator", () => {
  it("deduplicates task creation by idempotency key", async () => {
    const orchestrator = createOrchestrator();
    const first = await orchestrator.createTask(createTaskInput());
    const second = await orchestrator.createTask(createTaskInput());
    expect(second.id).toBe(first.id);
  });

  it("runs a task through review to a verified result", async () => {
    const orchestrator = createOrchestrator();
    const task = await orchestrator.createTask(createTaskInput());
    const completed = await orchestrator.runTask(task.id);

    expect(completed.status).toBe("succeeded");
    expect(completed.provider).toBe("fake");
    expect(completed.workerId).toBe("test-worker");
    expect(completed.leaseOwner).toBeUndefined();
    expect(completed.result?.artifacts).toHaveLength(1);
    expect(completed.result?.checks).toEqual([
      expect.objectContaining({ name: "Unit tests pass", outcome: "passed" }),
    ]);
  });

  it("coalesces concurrent execution requests for one task", async () => {
    const provider = new CountingProvider();
    const orchestrator = createOrchestrator(provider);
    const task = await orchestrator.createTask(createTaskInput());

    const [first, second] = await Promise.all([
      orchestrator.runTask(task.id),
      orchestrator.runTask(task.id),
    ]);

    expect(first.status).toBe("succeeded");
    expect(second.id).toBe(first.id);
    expect(provider.callCount).toBe(1);
  });

  it("fails a claimed success that does not prove every acceptance requirement", async () => {
    const orchestrator = createOrchestrator(new IncompleteProvider());
    const task = await orchestrator.createTask(createTaskInput());
    const completed = await orchestrator.runTask(task.id);
    expect(completed.status).toBe("failed");
  });

  it("aborts execution when the task timeout is exhausted", async () => {
    const orchestrator = createOrchestrator(new TimeoutProvider());
    const input = createTaskInput();
    input.task.timeoutMs = 100;
    const task = await orchestrator.createTask(input);
    const completed = await orchestrator.runTask(task.id);

    expect(completed.status).toBe("failed");
    expect(completed.result?.error).toMatchObject({ code: "TASK_TIMEOUT", retryable: true });
  });

  it("aborts a running provider when cancellation is requested", async () => {
    const provider = new AbortableProvider();
    const orchestrator = createOrchestrator(provider);
    const task = await orchestrator.createTask(createTaskInput());
    const execution = orchestrator.runTask(task.id);
    await provider.started;

    const cancelled = await orchestrator.cancelTask(task.id);
    expect(cancelled.status).toBe("cancelled");
    await expect(execution).resolves.toMatchObject({ status: "cancelled" });
  });

  it("rejects a stale result after the task lease is recovered", async () => {
    const provider = new ControlledProvider();
    const repository = new InMemoryTaskRepository();
    let now = new Date("2026-01-01T00:00:00.000Z");
    const orchestrator = new Orchestrator(repository, provider, {
      now: () => now,
      workerId: "stale-worker",
      leaseDurationMs: 60_000,
    });
    const task = await orchestrator.createTask(createTaskInput());
    const execution = orchestrator.runTask(task.id);
    await provider.started;

    now = new Date("2026-01-01T00:01:01.000Z");
    await expect(orchestrator.recoverExpiredTasks()).resolves.toBe(1);
    provider.complete({
      status: "succeeded",
      summary: "Late result",
      artifacts: [{ kind: "log", uri: "memory://late-result" }],
      checks: [{ name: "Unit tests pass", outcome: "passed" }],
      usage: { inputTokens: 1, outputTokens: 1, costMicros: 0 },
    });

    await expect(execution).rejects.toMatchObject({ code: "LEASE_LOST" });
    await expect(orchestrator.getTask(task.id)).resolves.toMatchObject({ status: "queued" });
  });
});
