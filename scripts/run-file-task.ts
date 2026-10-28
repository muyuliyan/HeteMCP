import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

import { submitTaskInputSchema, taskRecordSchema } from "../src/domain/schemas.js";

const inputPath = process.argv[2];
if (!inputPath) throw new Error("Usage: tsx scripts/run-file-task.ts <task.json>");
const raw: unknown = JSON.parse(await readFile(resolve(inputPath), "utf8"));
const input = submitTaskInputSchema.parse({
  idempotencyKey: randomUUID(),
  task: raw,
});
const env: Record<string, string> = {};
for (const name of [
  "SystemRoot",
  "WINDIR",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "PATH",
  "HETEMCP_DATABASE_URL",
  "HETEMCP_DSH_DESKTOP",
  "HETEMCP_CREDENTIALS_PATH",
  "HETEMCP_ALLOW_UNMETERED",
  "HETEMCP_ARTIFACT_ROOT",
]) {
  const value = process.env[name];
  if (value) env[name] = value;
}
if (!env.HETEMCP_DSH_DESKTOP)
  throw new Error("HETEMCP_DSH_DESKTOP is required; refusing a fake run");
const client = new Client({ name: "heteromcp-supervisor", version: "0.1.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve("dist/index.js")],
  env,
  stderr: "pipe",
});
const responseSchema = z.object({ task: taskRecordSchema });
try {
  await client.connect(transport);
  const response = await client.callTool({ name: "create_task", arguments: input });
  if (response.isError) throw new Error("MCP rejected task submission");
  let task = responseSchema.parse(response.structuredContent).task;
  console.log(JSON.stringify({ taskId: task.id, status: task.status }));
  const deadline = Date.now() + input.task.timeoutMs + 15_000;
  while (["queued", "running", "reviewing"].includes(task.status)) {
    if (Date.now() > deadline) {
      await client.callTool({ name: "cancel_task", arguments: { taskId: task.id } });
      throw new Error("Supervisor deadline exceeded; cancellation requested");
    }
    await setTimeout(1000);
    const response = await client.callTool({
      name: "get_task_result",
      arguments: { taskId: task.id },
    });
    task = responseSchema.parse(response.structuredContent).task;
  }
  const directory = resolve(".heteromcp/runs");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${task.id}.json`), JSON.stringify(task, null, 2), {
    flag: "wx",
  });
  console.log(JSON.stringify(task, null, 2));
  if (task.status !== "succeeded") process.exitCode = 1;
} finally {
  await client.close();
}
