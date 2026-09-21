import type { Orchestrator } from "./orchestrator.js";

export interface WorkerLoopOptions {
  pollIntervalMs?: number;
  onError?: (error: unknown) => void;
}

export class WorkerLoop {
  readonly #pollIntervalMs: number;
  readonly #onError: (error: unknown) => void;
  #timer: NodeJS.Timeout | undefined;
  #draining: Promise<number> | undefined;

  public constructor(
    private readonly orchestrator: Orchestrator,
    options: WorkerLoopOptions = {},
  ) {
    this.#pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.#onError =
      options.onError ?? ((error: unknown) => console.error("Worker loop failed", error));
  }

  public async start(): Promise<void> {
    if (this.#timer) return;
    await this.orchestrator.recoverExpiredTasks();
    this.#timer = setInterval(() => this.wake(), this.#pollIntervalMs);
    this.#timer.unref();
    this.wake();
  }

  public stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  public wake(): void {
    void this.drain().catch(this.#onError);
  }

  public drain(): Promise<number> {
    if (this.#draining) return this.#draining;
    this.#draining = this.#drainAvailable().finally(() => {
      this.#draining = undefined;
    });
    return this.#draining;
  }

  async #drainAvailable(): Promise<number> {
    let completed = 0;
    while (await this.orchestrator.runNextTask()) completed += 1;
    return completed;
  }
}
