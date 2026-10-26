import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { FileGenerationExecutor } from "../../src/application/file-generation-executor.js";
import type { AgentHarness } from "../../src/application/ports/agent-harness.js";
import { createTaskInput } from "../fixtures.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("isolated file generation", () => {
  it.each([false, true])("independently detects unexpected files: %s", async (extra) => {
    const directory = await mkdtemp(join(tmpdir(), "heteromcp-file-"));
    directories.push(directory);
    const harness: AgentHarness = {
      kind: "fixture",
      async execute(input) {
        await writeFile(join(input.workspacePath, "note.txt"), "fixture artifact");
        if (extra) await writeFile(join(input.workspacePath, "unexpected.txt"), "extra");
        return { status: "completed", exitCode: 0, sessionId: "fixture-session" };
      },
    };
    const executor = new FileGenerationExecutor(harness, directory);
    const spec = createTaskInput().task;
    spec.workerProfile = executor.name;
    spec.allowedPaths = ["note.txt"];
    spec.excludedPaths = [];
    spec.acceptance = ["generated-file-scope"];
    const result = await executor.execute({
      taskId: "task",
      attemptId: "attempt",
      spec,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe(extra ? "failed" : "succeeded");
    expect(result.usage.measured).toBe(false);
    const report = result.artifacts.find((a) => a.kind === "test-report");
    expect(report?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(fileURLToPath(report?.uri ?? ""), "utf8")).toContain("fixture-session");
    if (!extra) expect(result.artifacts.some((a) => a.kind === "source")).toBe(true);
  });

  it("rejects path traversal and unsupported acceptance before invoking the harness", async () => {
    let invoked = false;
    const harness: AgentHarness = {
      kind: "fixture",
      execute() {
        invoked = true;
        return Promise.resolve({ status: "completed", exitCode: 0 });
      },
    };
    const executor = new FileGenerationExecutor(harness, tmpdir());
    const spec = createTaskInput().task;
    spec.allowedPaths = ["../outside.cpp"];
    await expect(
      executor.execute({
        taskId: "task",
        attemptId: "attempt",
        spec,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("File generation requires");
    expect(invoked).toBe(false);
  });
});
