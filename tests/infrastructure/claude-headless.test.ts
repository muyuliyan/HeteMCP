import { describe, expect, it } from "vitest";

import type { HarnessExecution } from "../../src/application/ports/agent-harness.js";
import { ClaudeHeadlessAdapter } from "../../src/infrastructure/harnesses/claude-headless/adapter.js";

const expectedArgs = [
  "--print",
  "--output-format",
  "json",
  "--permission-mode",
  "acceptEdits",
  "--no-session-persistence",
  "--disable-slash-commands",
  "--strict-mcp-config",
  "--disallowedTools",
  "Bash,WebFetch,WebSearch",
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
  return new ClaudeHeadlessAdapter({
    executable: process.execPath,
    prefixArgs: ["-e", script, "--"],
    env: {},
    ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
  });
}

describe("Claude headless process boundary", () => {
  it("sends literal stdin and fixed headless flags", async () => {
    const result = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "claude-session",
    });
    const script = `let prompt = ''; process.stdin.setEncoding('utf8');
      process.stdin.on('data', c => prompt += c);
      process.stdin.on('end', () => {
        if (prompt !== ${JSON.stringify(request().prompt)} ||
          JSON.stringify(process.argv.slice(1)) !== ${JSON.stringify(
            JSON.stringify(expectedArgs),
          )}) process.exit(7);
        process.stdout.write(${JSON.stringify(result)});
      });`;
    await expect(adapter(script).execute(request())).resolves.toEqual({
      status: "completed",
      exitCode: 0,
      sessionId: "claude-session",
    });
  });

  it("passes an explicit model", async () => {
    const result = JSON.stringify({ type: "result", subtype: "success" });
    const script = `process.stdin.resume(); process.stdin.on('end', () => {
      const args = process.argv.slice(1);
      if (args.at(-2) !== '--model' || args.at(-1) !== 'claude-opus-5-5') process.exit(8);
      process.stdout.write(${JSON.stringify(result)});
    });`;
    await expect(
      adapter(script).execute({ ...request(), model: "claude-opus-5-5" }),
    ).resolves.toMatchObject({ status: "completed" });
  });

  it.each([
    [
      "reported error",
      JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true }),
      0,
      "PROCESS_FAILED",
    ],
    ["nonzero exit", JSON.stringify({ type: "result", subtype: "success" }), 2, "PROCESS_FAILED"],
    ["invalid JSON", "not json", 0, "PROTOCOL_ERROR"],
    ["missing result", "{}", 0, "PROTOCOL_ERROR"],
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

  it("reports a missing executable without exposing launch environment", async () => {
    const harness = new ClaudeHeadlessAdapter({
      executable: process.execPath + "-missing",
      env: { SECRET: "private" },
    });
    const result = await harness.execute(request());
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result)).not.toContain("private");
  });
});
