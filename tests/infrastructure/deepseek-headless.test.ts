import { describe, expect, it } from "vitest";

import { DeepSeekHeadlessAdapter } from "../../src/infrastructure/harnesses/deepseek-headless/adapter.js";
import type { HarnessExecution } from "../../src/application/ports/agent-harness.js";

const session = JSON.stringify({ type: "session", sessionId: "session-test" });
const final = JSON.stringify({
  type: "final",
  sessionId: "session-test",
  reason: { kind: "completed" },
});
const request = (signal = new AbortController().signal): HarnessExecution => ({
  taskId: "task",
  attemptId: "attempt",
  workspacePath: process.cwd(),
  prompt: "implement task; $(do not execute)",
  timeoutMs: 5_000,
  signal,
});

function adapter(script: string, maxOutputBytes?: number) {
  return new DeepSeekHeadlessAdapter({
    executable: process.execPath,
    prefixArgs: ["-e", script, "--"],
    env: {},
    ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
  });
}

describe("DeepSeek headless process boundary", () => {
  it.each([0, 1])("validates explicit legacy completion with exit %i", async (exitCode) => {
    const patch = process.execPath;
    const output = session + '\n{"type":"final","text":"done"}';
    const script = `process.stdin.resume(); process.stdin.on('end', () => {
      if (JSON.stringify(process.argv.slice(1)) !== ${JSON.stringify(
        JSON.stringify(["--profile", "headless", "--patch", patch, "--json", "-"]),
      )}) process.exit(9);
      process.stdout.write(${JSON.stringify(output)}); process.exitCode = ${String(exitCode)};
    });`;
    const harness = new DeepSeekHeadlessAdapter({
      executable: process.execPath,
      prefixArgs: ["-e", script, "--"],
      env: {},
      desktopLegacy: { version: "0.2.1-rc.2", policyPatch: patch },
    });
    await expect(harness.execute(request())).resolves.toMatchObject({
      status: exitCode === 0 ? "completed" : "failed",
      exitCode,
    });
  });
  it("sends literal stdin and fixed permission flags and requires a matching completion", async () => {
    const script = `let prompt = ''; process.stdin.setEncoding('utf8');
      process.stdin.on('data', c => prompt += c);
      process.stdin.on('end', () => {
        if (prompt !== ${JSON.stringify(request().prompt)} ||
          JSON.stringify(process.argv.slice(1)) !== ${JSON.stringify(
            JSON.stringify([
              "headless",
              "--permission-mode",
              "workspace-write",
              "--approval-policy",
              "never",
              "--json",
              "-",
            ]),
          )}) process.exit(7);
        process.stdout.write(${JSON.stringify(session + "\n" + final)});
      });`;
    await expect(adapter(script).execute(request())).resolves.toEqual({
      status: "completed",
      exitCode: 0,
      sessionId: "session-test",
    });
  });

  it.each([
    ["missing final", session, 0, "PROTOCOL_ERROR"],
    ["invalid JSON", "not json", 0, "PROTOCOL_ERROR"],
    ["unsupported legacy final", session + '\n{"type":"final","text":"done"}', 0, "PROTOCOL_ERROR"],
    ["nonzero exit", session + "\n" + final, 2, "PROCESS_FAILED"],
    [
      "incomplete turn",
      session + "\n" + final.replace('"completed"', '"max_tokens"'),
      0,
      "PROCESS_FAILED",
    ],
    [
      "different session",
      session + "\n" + final.replace("session-test", "another"),
      0,
      "PROTOCOL_ERROR",
    ],
    ["duplicate final", session + "\n" + final + "\n" + final, 0, "PROTOCOL_ERROR"],
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

  it("cancels a running worker", async () => {
    const controller = new AbortController();
    const running = adapter("setInterval(() => {}, 1000)").execute(request(controller.signal));
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      await expect(running).resolves.toMatchObject({ error: { code: "CANCELLED" } });
    } finally {
      clearTimeout(timer);
    }
  });

  it("reports a missing executable without exposing launch environment", async () => {
    const harness = new DeepSeekHeadlessAdapter({
      executable: process.execPath + "-missing",
      env: { SECRET: "private" },
    });
    const result = await harness.execute(request());
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result)).not.toContain("private");
  });
});
