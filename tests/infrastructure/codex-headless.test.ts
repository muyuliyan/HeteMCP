import { describe, expect, it } from "vitest";

import type { HarnessExecution } from "../../src/application/ports/agent-harness.js";
import { CodexHeadlessAdapter } from "../../src/infrastructure/harnesses/codex-headless/adapter.js";

const expectedArgs = [
  "exec",
  "--json",
  "--sandbox",
  "workspace-write",
  "--skip-git-repo-check",
  "--color",
  "never",
  "--ephemeral",
  "-c",
  "mcp_servers={}",
  "-",
];
const request = (signal = new AbortController().signal): HarnessExecution => ({
  taskId: "task",
  attemptId: "attempt",
  workspacePath: process.cwd(),
  prompt: "implement task; $(do not execute)",
  timeoutMs: 5_000,
  signal,
});

function adapter(script: string, maxOutputBytes?: number) {
  return new CodexHeadlessAdapter({
    executable: process.execPath,
    prefixArgs: ["-e", script, "--"],
    env: {},
    ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
  });
}

describe("Codex headless process boundary", () => {
  it("sends literal stdin and fixed exec flags", async () => {
    const output = [
      JSON.stringify({ type: "thread.started", thread_id: "codex-session" }),
      JSON.stringify({ type: "turn.completed" }),
    ].join("\n");
    const script = `let prompt = ''; process.stdin.setEncoding('utf8');
      process.stdin.on('data', c => prompt += c);
      process.stdin.on('end', () => {
        if (prompt !== ${JSON.stringify(request().prompt)} ||
          JSON.stringify(process.argv.slice(1)) !== ${JSON.stringify(
            JSON.stringify(expectedArgs),
          )}) process.exit(7);
        process.stdout.write(${JSON.stringify(output)});
      });`;
    await expect(adapter(script).execute(request())).resolves.toEqual({
      status: "completed",
      exitCode: 0,
      sessionId: "codex-session",
    });
  });

  it("passes an explicit model", async () => {
    const script = `process.stdin.resume(); process.stdin.on('end', () => {
      const args = process.argv.slice(1);
      if (!args.includes('--model') || !args.includes('gpt-5')) process.exit(8);
      process.stdout.write(${JSON.stringify(JSON.stringify({ type: "turn.completed" }))});
    });`;
    await expect(adapter(script).execute({ ...request(), model: "gpt-5" })).resolves.toMatchObject({
      status: "completed",
    });
  });

  it.each([
    ["nonzero exit", JSON.stringify({ type: "turn.completed" }), 2, "PROCESS_FAILED"],
    [
      "reported error event",
      JSON.stringify({ type: "turn.failed", error: { message: "failed" } }),
      0,
      "PROCESS_FAILED",
    ],
  ])("rejects %s", async (_, output, exitCode, code) => {
    const script = `process.stdin.resume(); process.stdin.on('end', () => {
      process.stdout.write(${JSON.stringify(output)}); process.exitCode = ${String(exitCode)};
    });`;
    await expect(adapter(script).execute(request())).resolves.toMatchObject({
      status: "failed",
      error: { code },
    });
  });

  it("bounds diagnostics without returning them", async () => {
    const result = await adapter(
      "process.stderr.write('secret'.repeat(100)); setInterval(() => {}, 1000)",
      64,
    ).execute(request());
    expect(result).toMatchObject({ status: "failed", error: { code: "OUTPUT_LIMIT" } });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("terminates a timed-out worker", async () => {
    await expect(
      adapter("setInterval(() => {}, 1000)").execute({ ...request(), timeoutMs: 100 }),
    ).resolves.toMatchObject({ status: "failed", error: { code: "TIMEOUT" } });
  });

  it("handles an already aborted request without spawning", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      adapter("process.exit(99)").execute(request(controller.signal)),
    ).resolves.toMatchObject({ exitCode: null, error: { code: "CANCELLED" } });
  });

  it("reports a missing executable", async () => {
    const harness = new CodexHeadlessAdapter({
      executable: process.execPath + "-missing",
      env: {},
    });
    await expect(harness.execute(request())).resolves.toMatchObject({
      status: "failed",
      error: { code: "START_FAILED" },
    });
  });
});
