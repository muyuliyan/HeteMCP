import { spawn } from "node:child_process";
import { isAbsolute, join } from "node:path";

import { z } from "zod";

import type {
  AgentHarness,
  HarnessErrorCode,
  HarnessExecution,
  HarnessOutcome,
} from "../../../application/ports/agent-harness.js";

const eventSchema = z.object({ type: z.string() });
const sessionSchema = z.object({ type: z.literal("session"), sessionId: z.string().min(1) });
const finalSchema = z.object({
  type: z.literal("final"),
  sessionId: z.string().min(1),
  reason: z.object({ kind: z.string() }).nullable(),
});

export interface DeepSeekHeadlessOptions {
  // On Windows, use node.exe plus the pinned CLI entrypoint, not an npm .cmd shim.
  executable: string;
  prefixArgs?: readonly string[];
  env: Readonly<Record<string, string>>;
  maxOutputBytes?: number;
  desktopLegacy?: { version: "0.2.1-rc.2"; policyPatch: string };
}

export class DeepSeekHeadlessAdapter implements AgentHarness {
  public readonly kind = "deepseek-headless";
  readonly #limit: number;

  public constructor(private readonly options: DeepSeekHeadlessOptions) {
    this.#limit = options.maxOutputBytes ?? 8 * 1024 * 1024;
    if (!isAbsolute(options.executable) || !Number.isSafeInteger(this.#limit) || this.#limit < 1) {
      throw new Error("Harness requires an absolute executable and a positive output limit");
    }
    if (options.desktopLegacy && !isAbsolute(options.desktopLegacy.policyPatch)) {
      throw new Error("Legacy desktop execution requires an absolute audited policy patch");
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
      throw new Error("Harness requires an absolute workspace, a prompt and a bounded timeout");
    }
    if (input.signal.aborted) return Promise.resolve(this.#failure("CANCELLED", null));

    return new Promise((resolve) => {
      const child = spawn(
        this.options.executable,
        [
          ...(this.options.prefixArgs ?? []),
          ...(this.options.desktopLegacy
            ? ["--profile", "headless", "--patch", this.options.desktopLegacy.policyPatch]
            : ["headless", "--permission-mode", "workspace-write", "--approval-policy", "never"]),
          "--json",
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
      let finalKind: string | null | undefined;
      let termination: Promise<void> = Promise.resolve();
      let stopping = false;
      let closed = false;

      const stop = (code: HarnessErrorCode) => {
        failure ??= code;
        if (stopping || closed) return;
        stopping = true;
        // Await both tree termination and stdio closure before returning to the supervisor.
        termination = terminateTree(child.pid);
      };
      const acceptLine = (line: string) => {
        if (failure || !line.trim()) return;
        try {
          const raw: unknown = JSON.parse(line);
          const event = eventSchema.parse(raw);
          if (finalKind !== undefined) throw new Error("Event after final");
          if (event.type === "session") {
            if (sessionId) throw new Error("Duplicate session");
            sessionId = sessionSchema.parse(raw).sessionId;
          } else if (event.type === "error") {
            stop("PROCESS_FAILED");
          } else {
            if (!sessionId) throw new Error("Missing initial session");
            if (event.type === "final") {
              if (this.options.desktopLegacy) {
                z.object({ type: z.literal("final"), text: z.string() }).parse(raw);
                // Inspected 0.2.1-rc.2 runner exits zero only for completed turns.
                finalKind = "completed";
              } else {
                const event = finalSchema.parse(raw);
                if (event.sessionId !== sessionId) throw new Error("Session mismatch");
                finalKind = event.reason?.kind ?? null;
              }
            }
          }
        } catch {
          stop("PROTOCOL_ERROR");
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
      // Raw tool output, reasoning and diagnostics are deliberately not returned or logged.
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
          const error =
            failure ??
            (exitCode !== 0
              ? "PROCESS_FAILED"
              : finalKind === undefined
                ? "PROTOCOL_ERROR"
                : finalKind !== "completed"
                  ? "PROCESS_FAILED"
                  : undefined);
          const outcome: HarnessOutcome = error
            ? this.#failure(error, exitCode)
            : { status: "completed", exitCode };
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
        message: `Harness execution ended: ${code}`,
      },
    };
  }
}

async function terminateTree(pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    // Use the OS tool's absolute path, never a PATH entry supplied to the worker.
    const root = process.env.SystemRoot ?? "C:\\Windows";
    await new Promise<void>((resolve) => {
      const killer = spawn(
        join(root, "System32", "taskkill.exe"),
        ["/PID", String(pid), "/T", "/F"],
        {
          windowsHide: true,
          shell: false,
          stdio: "ignore",
        },
      );
      killer.on("error", () => resolve());
      killer.on("close", () => resolve());
    });
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* The process group may have exited already. */
    }
  }
}
