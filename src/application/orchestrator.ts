import { randomUUID } from "node:crypto";

import { DomainError } from "../domain/errors.js";
import {
  attemptResultSchema,
  submitTaskInputSchema,
  taskRecordSchema,
  type SubmitTaskInput,
  type TaskRecord,
} from "../domain/schemas.js";
import { isTerminalStatus, transitionTask } from "../domain/task.js";
import type { ModelProvider } from "./ports/model-provider.js";
import type { TaskRepository } from "./ports/task-repository.js";

export interface OrchestratorOptions {
  now?: () => Date;
  createId?: () => string;
}

export class Orchestrator {
  readonly #running = new Map<string, AbortController>();
  readonly #executions = new Map<string, Promise<TaskRecord>>();
  readonly #now: () => Date;
  readonly #createId: () => string;

  public constructor(
    private readonly repository: TaskRepository,
    private readonly provider: ModelProvider,
    options: OrchestratorOptions = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
  }

  public async createTask(rawInput: SubmitTaskInput): Promise<TaskRecord> {
    const input = submitTaskInputSchema.parse(rawInput);
    const existing = await this.repository.findByIdempotencyKey(input.idempotencyKey);
    if (existing) return existing;

    const timestamp = this.#now().toISOString();
    const task = taskRecordSchema.parse({
      id: this.#createId(),
      idempotencyKey: input.idempotencyKey,
      status: "queued",
      spec: input.task,
      revision: 0,
      cancellationRequested: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    return this.repository.create(task);
  }

  public async getTask(taskId: string): Promise<TaskRecord> {
    const task = await this.repository.findById(taskId);
    if (!task) throw new DomainError("TASK_NOT_FOUND", `Task ${taskId} was not found`);
    return task;
  }

  public async cancelTask(taskId: string): Promise<TaskRecord> {
    const task = await this.getTask(taskId);
    if (isTerminalStatus(task.status)) return task;

    this.#running.get(taskId)?.abort("Task cancellation requested");
    const cancelled = transitionTask(
      { ...task, cancellationRequested: true },
      "cancelled",
      this.#now().toISOString(),
    );
    return this.repository.update(cancelled, task.revision);
  }

  public runTask(taskId: string): Promise<TaskRecord> {
    const existing = this.#executions.get(taskId);
    if (existing) return existing;

    const execution = this.#executeTask(taskId).finally(() => {
      this.#executions.delete(taskId);
    });
    this.#executions.set(taskId, execution);
    return execution;
  }

  async #executeTask(taskId: string): Promise<TaskRecord> {
    const queued = await this.getTask(taskId);
    if (queued.status !== "queued") return queued;

    const attemptId = this.#createId();
    const started = transitionTask(
      { ...queued, attemptId, provider: this.provider.name },
      "running",
      this.#now().toISOString(),
    );
    await this.repository.update(started, queued.revision);

    const controller = new AbortController();
    this.#running.set(taskId, controller);
    const timeoutReason = new Error(`Task ${taskId} exceeded its execution timeout`);
    const timeout = setTimeout(() => controller.abort(timeoutReason), queued.spec.timeoutMs);
    timeout.unref();

    try {
      // Cancellation can race with the transition to running before the controller is registered.
      const current = await this.getTask(taskId);
      if (current.status === "cancelled") return current;

      const rawResult = await this.provider.execute({
        taskId,
        attemptId,
        spec: queued.spec,
        signal: controller.signal,
      });
      const result = attemptResultSchema.parse(rawResult);
      return await this.#completeTask(taskId, result);
    } catch (error: unknown) {
      const current = await this.getTask(taskId);
      if (current.status === "cancelled") return current;

      const isTimeout = controller.signal.reason === timeoutReason;
      const message = error instanceof Error ? error.message : "Unknown provider failure";
      const failed = transitionTask(
        {
          ...current,
          result: {
            status: "failed",
            summary: "Provider execution failed",
            artifacts: [],
            checks: [],
            usage: { inputTokens: 0, outputTokens: 0, costMicros: 0 },
            error: {
              code: isTimeout ? "TASK_TIMEOUT" : "PROVIDER_FAILURE",
              retryable: isTimeout,
              message,
            },
          },
        },
        "failed",
        this.#now().toISOString(),
      );
      return await this.repository.update(failed, current.revision);
    } finally {
      clearTimeout(timeout);
      this.#running.delete(taskId);
    }
  }

  async #completeTask(taskId: string, result: ReturnType<typeof attemptResultSchema.parse>) {
    const current = await this.getTask(taskId);
    if (current.status === "cancelled") return current;

    if (result.status === "blocked") {
      const blocked = transitionTask({ ...current, result }, "blocked", this.#now().toISOString());
      return this.repository.update(blocked, current.revision);
    }

    if (result.status === "failed") {
      const failed = transitionTask({ ...current, result }, "failed", this.#now().toISOString());
      return this.repository.update(failed, current.revision);
    }

    const reviewing = transitionTask(
      { ...current, result },
      "reviewing",
      this.#now().toISOString(),
    );
    const savedReview = await this.repository.update(reviewing, current.revision);
    const hasPassedAcceptance = current.spec.acceptance.every((requirement) =>
      result.checks.some((check) => check.name === requirement && check.outcome === "passed"),
    );
    const hasEvidence = result.artifacts.length > 0;
    const finalStatus = hasPassedAcceptance && hasEvidence ? "succeeded" : "failed";
    const completed = transitionTask(savedReview, finalStatus, this.#now().toISOString());
    return this.repository.update(completed, savedReview.revision);
  }
}
