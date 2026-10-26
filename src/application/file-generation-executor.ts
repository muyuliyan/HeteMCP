import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, lstat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { AgentHarness } from "./ports/agent-harness.js";
import type { TaskExecution, TaskExecutor } from "./ports/task-executor.js";
import type { AttemptResult } from "../domain/schemas.js";

export const fileGenerationAcceptance = "generated-file-scope";

// Narrow opt-in file-generation profile: creates a new file, never mutates a checkout.
// Build/behavior review and publication remain with the supervising client.
export class FileGenerationExecutor implements TaskExecutor {
  public readonly name = "deepseek-file-generation";
  public constructor(
    private readonly harness: AgentHarness,
    private readonly artifactRoot: string,
  ) {}

  public async execute(input: TaskExecution): Promise<AttemptResult> {
    const filename = input.spec.allowedPaths[0];
    if (
      input.spec.workerProfile !== this.name ||
      input.spec.allowedPaths.length !== 1 ||
      !filename ||
      !/^[a-zA-Z0-9_-]+\.(cpp|txt|md)$/.test(filename) ||
      input.spec.excludedPaths.length > 0 ||
      input.spec.acceptance.length !== 1 ||
      input.spec.acceptance[0] !== fileGenerationAcceptance
    ) {
      throw new Error(
        "File generation requires one plain filename and generated-file-scope acceptance",
      );
    }
    if (!/^[a-zA-Z0-9-]+$/.test(input.taskId) || !/^[a-zA-Z0-9-]+$/.test(input.attemptId)) {
      throw new Error("Invalid execution identity");
    }
    const attemptDirectory = join(resolve(this.artifactRoot), input.taskId, input.attemptId);
    await mkdir(attemptDirectory, { recursive: true });
    const workspace = join(attemptDirectory, "workspace");
    await mkdir(workspace); // A reused attempt must not silently reuse edited files.
    const outcome = await this.harness.execute({
      taskId: input.taskId,
      attemptId: input.attemptId,
      workspacePath: workspace,
      prompt: [
        "Implement the following task now. Write the actual file using filesystem tools.",
        `Create only ${filename} in the current workspace. Do not create other files.`,
        "Do not run commands, access credentials, install packages, delegate, or publish changes.",
        "The supervisor will compile and test the file independently.",
        input.spec.objective,
        `Context: ${input.spec.context.summary}`,
      ].join("\n"),
      timeoutMs: input.spec.timeoutMs,
      signal: input.signal,
    });
    input.signal.throwIfAborted();
    const entries = await readdir(workspace);
    const filePath = join(workspace, filename);
    const metadata = await lstat(filePath).catch(() => undefined);
    const scopePassed =
      entries.length === 1 &&
      entries[0] === filename &&
      metadata?.isFile() === true &&
      metadata.size > 0 &&
      metadata.size <= 128 * 1024;
    const checks: AttemptResult["checks"] = [
      {
        name: fileGenerationAcceptance,
        outcome: scopePassed && outcome.status === "completed" ? "passed" : "failed",
        evidence:
          "Independent filesystem inspection; compilation and functional checks are not included.",
      },
    ];
    const artifacts: AttemptResult["artifacts"] = [];
    if (scopePassed) {
      const bytes = await readFile(filePath);
      artifacts.push({ kind: "source", uri: pathToFileURL(filePath).href, sha256: hash(bytes) });
    }
    const report = Buffer.from(
      JSON.stringify(
        {
          taskId: input.taskId,
          attemptId: input.attemptId,
          harness: this.harness.kind,
          outcome,
          checks,
          artifacts,
          budgetEnforced: false,
          usageMeasured: false,
          scope: "isolated new-file generation; no repository publication",
        },
        null,
        2,
      ),
    );
    const reportPath = join(attemptDirectory, "report.json");
    await writeFile(reportPath, report, { flag: "wx" });
    artifacts.push({
      kind: "test-report",
      uri: pathToFileURL(reportPath).href,
      sha256: hash(report),
    });
    const passed = scopePassed && outcome.status === "completed";
    return {
      status: passed ? "succeeded" : "failed",
      summary: passed
        ? "File generated and scope verified; supervisor build/review required."
        : "Harness execution or independent file scope verification failed.",
      artifacts,
      checks,
      usage: { inputTokens: 0, outputTokens: 0, costMicros: 0, measured: false },
      ...(!passed
        ? {
            error: outcome.error ?? {
              code: "FILE_SCOPE_FAILED",
              retryable: false,
              message: "Missing, empty or unexpected generated files",
            },
          }
        : {}),
    };
  }
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
