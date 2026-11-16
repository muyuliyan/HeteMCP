import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

import { z } from "zod";

import type {
  AgentHarness,
  HarnessErrorCode,
  HarnessExecution,
  HarnessOutcome,
} from "../../../application/ports/agent-harness.js";
import { terminateTree } from "../process-tree.js";

const eventSchema = z.looseObject({ type: z.string().min(1) });

export interface CodexHeadlessOptions {
  // Absolute path to the Codex CLI executable.
  executable: string;
  prefixArgs?: readonly string[];
  env: Readonly<Record<string, string>>;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  maxOutputBytes?: number;
}

// Codex exec is non-interactive: the prompt arrives on stdin, JSONL events on stdout,
// and the process exit code is authoritative. Events only supply diagnostics/session IDs.
export class CodexHeadlessAdapter implements AgentHarness {
  public readonly kind = "codex-headless";
  readonly #limit: number;

  public constructor(private readonly options: CodexHeadlessOptions) {
    this.#limit = options.maxOutputBytes ?? 8 * 1024 * 1024;
    if (!isAbsolute(options.executable) || !Number.isSafeInteger(this.#limit) || this.#limit < 1) {
      throw new Error("Codex harness requires an absolute executable and a positive output limit");
    }
  }

  public execute(input: HarnessExecution): Promise<HarnessOutcome> {
    if (
      !isAbsolute(input.workspacePath) ||
      !input.prompt.trim() ||
      !Number.isSafeInteger(input.timeoutMs) ||
      input.timeoutMs < 1 ||
      input.timeoutMs > 2_147_483_647
    ) {
      throw new Error("Codex harness requires an absolute workspace, a prompt and a timeout");
    }
    if (input.signal.aborted) return Promise.resolve(this.#failure("CANCELLED", null));

    return new Promise((resolve) => {
      const child = spawn(
        this.options.executable,
        [
          ...(this.options.prefixArgs ?? []),
          "exec",
          "--json",
          "--sandbox",
          this.options.sandbox ?? "workspace-write",
          "--skip-git-repo-check",
          "--color",
          "never",
          "--ephemeral",
          "-c",
          "mcp_servers={}",
          ...(input.model === undefined ? [] : ["--model", input.model]),
          "-",
        ],
        {
          cwd: input.workspacePath,
          env: { ...this.options.env },
          shell: false,
          windowsHide: true,
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let failure: HarnessErrorCode | undefined;
      let pending = "";
      let bytes = 0;
      let sessionId: string | undefined;
      let reportedError = false;
      let termination: Promise<void> = Promise.resolve();
      let stopping = false;
      let closed = false;

      const stop = (code: HarnessErrorCode) => {
        failure ??= code;
        if (stopping || closed) return;
        stopping = true;
        termination = terminateTree(child.pid);
      };
      const acceptLine = (line: string) => {
        if (failure || !line.trim()) return;
        try {
          const raw: unknown = JSON.parse(line);
          const event = eventSchema.parse(raw);
          if (event.type === "thread.started") {
            const threadId = rawRecord(raw)?.thread_id ?? rawRecord(raw)?.threadId;
            if (typeof threadId === "string" && threadId) sessionId = threadId;
          } else if (event.type === "error" || event.type === "turn.failed") {
            reportedError = true;
          }
        } catch {
          // Codex may add human-readable lines to stdout; they are not part of the contract.
        }
      };
      const account = (size: number) => {
        bytes += size;
        if (bytes > this.#limit) stop("OUTPUT_LIMIT");
        return !failure;
      };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (!account(Buffer.byteLength(chunk))) return;
        pending += chunk;
        let newline: number;
        while ((newline = pending.indexOf("\n")) >= 0) {
          acceptLine(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
        }
      });
      // Raw diagnostics are deliberately not returned or logged.
      child.stderr.on("data", (chunk: Buffer) => {
        account(chunk.length);
      });
      child.stdin.on("error", () => {
        stop("PROCESS_FAILED");
      });
      child.on("error", () => {
        failure ??= "START_FAILED";
      });
      const abort = () => stop("CANCELLED");
      input.signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => stop("TIMEOUT"), input.timeoutMs);
      child.on("close", (exitCode) => {
        closed = true;
        clearTimeout(timer);
        input.signal.removeEventListener("abort", abort);
        if (pending.trim()) acceptLine(pending);
        void termination.then(() => {
          const error = failure ?? (exitCode !== 0 || reportedError ? "PROCESS_FAILED" : undefined);
          if (error) {
            resolve(this.#failure(error, exitCode));
            return;
          }
          const outcome: HarnessOutcome = { status: "completed", exitCode };
          if (sessionId) outcome.sessionId = sessionId;
          resolve(outcome);
        });
      });
      if (input.signal.aborted) abort();
      if (!failure) child.stdin.end(input.prompt);
      else child.stdin.destroy();
    });
  }

  #failure(code: HarnessErrorCode, exitCode: number | null): HarnessOutcome {
    return {
      status: "failed",
      exitCode,
      error: {
        code,
        retryable: false,
        message: `Codex harness execution ended: ${code}`,
      },
    };
  }
}

function rawRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}
