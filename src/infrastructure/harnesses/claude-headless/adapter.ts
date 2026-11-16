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

const resultSchema = z.object({
  type: z.literal("result"),
  subtype: z.string().min(1),
  is_error: z.boolean().optional(),
  session_id: z.string().min(1).optional(),
});

export interface ClaudeHeadlessOptions {
  // Absolute path to the Claude Code CLI executable.
  executable: string;
  prefixArgs?: readonly string[];
  env: Readonly<Record<string, string>>;
  permissionMode?: "acceptEdits" | "dontAsk" | "plan";
  disallowedTools?: readonly string[];
  maxOutputBytes?: number;
}

// Claude Code print mode is a process boundary like the DSH adapter: prompts on stdin,
// one JSON result on stdout, and completion decided by the CLI's typed result.
export class ClaudeHeadlessAdapter implements AgentHarness {
  public readonly kind = "claude-headless";
  readonly #limit: number;

  public constructor(private readonly options: ClaudeHeadlessOptions) {
    this.#limit = options.maxOutputBytes ?? 8 * 1024 * 1024;
    if (!isAbsolute(options.executable) || !Number.isSafeInteger(this.#limit) || this.#limit < 1) {
      throw new Error("Claude harness requires an absolute executable and a positive output limit");
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
      throw new Error("Claude harness requires an absolute workspace, a prompt and a timeout");
    }
    if (input.signal.aborted) return Promise.resolve(this.#failure("CANCELLED", null));

    return new Promise((resolve) => {
      const child = spawn(
        this.options.executable,
        [
          ...(this.options.prefixArgs ?? []),
          "--print",
          "--output-format",
          "json",
          "--permission-mode",
          this.options.permissionMode ?? "acceptEdits",
          "--no-session-persistence",
          "--disable-slash-commands",
          "--strict-mcp-config",
          "--disallowedTools",
          (this.options.disallowedTools ?? ["Bash", "WebFetch", "WebSearch"]).join(","),
          ...(input.model === undefined ? [] : ["--model", input.model]),
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
      let stdout = "";
      let bytes = 0;
      let termination: Promise<void> = Promise.resolve();
      let stopping = false;
      let closed = false;

      const stop = (code: HarnessErrorCode) => {
        failure ??= code;
        if (stopping || closed) return;
        stopping = true;
        termination = terminateTree(child.pid);
      };
      const account = (size: number) => {
        bytes += size;
        if (bytes > this.#limit) stop("OUTPUT_LIMIT");
        return !failure;
      };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (!account(Buffer.byteLength(chunk))) return;
        stdout += chunk;
      });
      // Diagnostics are bounded but never returned or logged.
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
        void termination.then(() => {
          if (failure) {
            resolve(this.#failure(failure, exitCode));
            return;
          }
          if (exitCode !== 0) {
            resolve(this.#failure("PROCESS_FAILED", exitCode));
            return;
          }
          const result = parseResult(stdout);
          if (!result) {
            resolve(this.#failure("PROTOCOL_ERROR", exitCode));
            return;
          }
          if (result.is_error === true || result.subtype !== "success") {
            resolve(this.#failure("PROCESS_FAILED", exitCode));
            return;
          }
          const outcome: HarnessOutcome = { status: "completed", exitCode };
          if (result.session_id) outcome.sessionId = result.session_id;
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
        message: `Claude harness execution ended: ${code}`,
      },
    };
  }
}

function parseResult(stdout: string): z.infer<typeof resultSchema> | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  const candidates = [trimmed, ...trimmed.split(/\r?\n/).reverse()];
  for (const candidate of candidates) {
    if (!candidate.startsWith("{")) continue;
    try {
      const parsed = resultSchema.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data;
    } catch {
      /* Try the next candidate. */
    }
  }
  return undefined;
}
