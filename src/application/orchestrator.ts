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
import type { TaskClaim, TaskRepository } from "./ports/task-repository.js";

export interface OrchestratorOptions {
  now?: () => Date;
  createId?: () => string;
  workerId?: string;
  leaseDurationMs?: number;
}

export class Orchestrator {
  readonly #running = new Map<string, AbortController>();
  readonly #executions = new Map<string, Promise<TaskRecord>>();
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #workerId: string;
  readonly #leaseDurationMs: number;

  public constructor(
    private readonly repository: TaskRepository,
    private readonly provider: ModelProvider,
    options: OrchestratorOptions = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#createId = options.createId ?? randomUUID;
    this.#workerId = options.workerId ?? `local-${randomUUID()}`;
    this.#leaseDurationMs = options.leaseDurationMs ?? 30_000;
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
      attemptCount: 0,
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
      this.#releaseLease({ ...task, cancellationRequested: true }),
      "cancelled",
      this.#now().toISOString(),
    );
    return this.repository.update(cancelled, task.revision);
  }

  public runTask(taskId: string): Promise<TaskRecord> {
    const existing = this.#executions.get(taskId);
    if (existing) return existing;

    const execution = this.#claimAndExecute(taskId).finally(() => {
      this.#executions.delete(taskId);
    });
    this.#executions.set(taskId, execution);
    return execution;
  }

  public async runNextTask(): Promise<TaskRecord | undefined> {
    const claimed = await this.repository.claimNext(this.#createClaim());
    return claimed ? this.#executeClaimed(claimed) : undefined;
  }

  public recoverExpiredTasks(): Promise<number> {
    return this.repository.requeueExpired(this.#now().toISOString());
  }

  async #claimAndExecute(taskId: string): Promise<TaskRecord> {
    const claimed = await this.repository.claimById(taskId, this.#createClaim());
    return claimed ? this.#executeClaimed(claimed) : this.getTask(taskId);
  }

  async #executeClaimed(claimed: TaskRecord): Promise<TaskRecord> {
    const attemptId = claimed.attemptId;
    if (!attemptId) throw new DomainError("LEASE_LOST", `Task ${claimed.id} has no attempt ID`);

    const controller = new AbortController();
    this.#running.set(claimed.id, controller);
    const timeoutReason = new Error(`Task ${claimed.id} exceeded its execution timeout`);
    const timeout = setTimeout(() => controller.abort(timeoutReason), claimed.spec.timeoutMs);
    timeout.unref();
    const heartbeat = setInterval(
      () => {
        void this.#renewLease(claimed.id, attemptId, controller).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : "Unknown lease renewal failure";
          controller.abort(new DomainError("LEASE_LOST", message, true));
        });
      },
      Math.max(50, Math.floor(this.#leaseDurationMs / 3)),
    );
    heartbeat.unref();

    try {
      const current = await this.getTask(claimed.id);
      if (current.status === "cancelled") return current;

      const rawResult = await this.provider.execute({
        taskId: claimed.id,
        attemptId,
        spec: claimed.spec,
        signal: controller.signal,
      });
      const result = attemptResultSchema.parse(rawResult);
      return await this.#completeTask(claimed.id, attemptId, result);
    } catch (error: unknown) {
      const current = await this.getTask(claimed.id);
      if (current.status === "cancelled") return current;
      if (
        controller.signal.reason instanceof DomainError &&
        controller.signal.reason.code === "LEASE_LOST"
      ) {
        throw controller.signal.reason;
      }
      if (!this.#ownsLease(current, attemptId)) {
        throw new DomainError(
          "LEASE_LOST",
          `Task ${claimed.id} lease belongs to another attempt`,
          true,
        );
      }

      const isTimeout = controller.signal.reason === timeoutReason;
      const message = error instanceof Error ? error.message : "Unknown provider failure";
      const failed = transitionTask(
        this.#releaseLease({
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
        }),
        "failed",
        this.#now().toISOString(),
      );
      return await this.repository.update(failed, current.revision);
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      this.#running.delete(claimed.id);
    }
  }

  async #completeTask(
    taskId: string,
    attemptId: string,
    result: ReturnType<typeof attemptResultSchema.parse>,
  ) {
    const current = await this.getTask(taskId);
    if (current.status === "cancelled") return current;
    if (!this.#ownsLease(current, attemptId)) {
      throw new DomainError("LEASE_LOST", `Task ${taskId} lease belongs to another attempt`, true);
    }

    if (result.status === "blocked") {
      const blocked = transitionTask(
        this.#releaseLease({ ...current, result }),
        "blocked",
        this.#now().toISOString(),
      );
      return this.repository.update(blocked, current.revision);
    }

    if (result.status === "failed") {
      const failed = transitionTask(
        this.#releaseLease({ ...current, result }),
        "failed",
        this.#now().toISOString(),
      );
      return this.repository.update(failed, current.revision);
    }

    const reviewing = transitionTask(
      this.#releaseLease({ ...current, result }),
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

  #createClaim(): TaskClaim {
    const claimedAt = this.#now();
    return {
      attemptId: this.#createId(),
      workerId: this.#workerId,
      provider: this.provider.name,
      claimedAt: claimedAt.toISOString(),
      leaseExpiresAt: new Date(claimedAt.getTime() + this.#leaseDurationMs).toISOString(),
    };
  }

  async #renewLease(taskId: string, attemptId: string, controller: AbortController) {
    const now = this.#now();
    const renewed = await this.repository.renewLease(
      taskId,
      attemptId,
      this.#workerId,
      new Date(now.getTime() + this.#leaseDurationMs).toISOString(),
    );
    if (!renewed) controller.abort(new DomainError("LEASE_LOST", `Task ${taskId} lease was lost`));
  }

  #ownsLease(task: TaskRecord, attemptId: string): boolean {
    return (
      task.status === "running" &&
      task.attemptId === attemptId &&
      task.leaseOwner === this.#workerId
    );
  }

  #releaseLease(task: TaskRecord): TaskRecord {
    const released = structuredClone(task);
    delete released.leaseOwner;
    delete released.leaseExpiresAt;
    return released;
  }
}
