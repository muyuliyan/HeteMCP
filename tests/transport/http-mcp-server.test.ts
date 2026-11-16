import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { Orchestrator } from "../../src/application/orchestrator.js";
import { taskRecordSchema } from "../../src/domain/schemas.js";
import { FakeProvider } from "../../src/infrastructure/providers/fake-provider.js";
import { InMemoryTaskRepository } from "../../src/infrastructure/repositories/in-memory-task-repository.js";
import { startHttpMcpServer } from "../../src/transport/mcp/http.js";
import { createTaskInput } from "../fixtures.js";

const closeables: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(closeables.splice(0).map((closeable) => closeable.close()));
});

const taskResponseSchema = z.object({ task: taskRecordSchema });

describe("MCP streamable HTTP transport", () => {
  it("serves CC-switch-style clients over a local port", async () => {
    const orchestrator = new Orchestrator(new InMemoryTaskRepository(), new FakeProvider());
    const server = await startHttpMcpServer({ orchestrator, host: "127.0.0.1", port: 0 });
    closeables.push(server);
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

    const health = await fetch(server.url.replace(/\/mcp$/, "/healthz"));
    await expect(health.json()).resolves.toEqual({ status: "ok" });

    const client = new Client({ name: "heteromcp-http-test", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(server.url));
    closeables.push(client);
    await client.connect(transport as unknown as Transport);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("list_workers");

    const createdResponse = await client.callTool({
      name: "create_task",
      arguments: createTaskInput(),
    });
    expect(createdResponse.isError).not.toBe(true);
    const created = taskResponseSchema.parse(createdResponse.structuredContent).task;

    let current = created;
    for (let attempt = 0; attempt < 10 && current.status !== "succeeded"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const response = await client.callTool({
        name: "get_task_result",
        arguments: { taskId: created.id },
      });
      current = taskResponseSchema.parse(response.structuredContent).task;
    }
    expect(current.status).toBe("succeeded");
  });

  it("requires the configured bearer token", async () => {
    const orchestrator = new Orchestrator(new InMemoryTaskRepository(), new FakeProvider());
    const server = await startHttpMcpServer({
      orchestrator,
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
    });
    closeables.push(server);

    const unauthorized = await fetch(server.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(unauthorized.status).toBe(401);

    const client = new Client({ name: "heteromcp-http-test", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: "Bearer test-token" } },
    });
    closeables.push(client);
    await client.connect(transport as unknown as Transport);
    await expect(client.listTools()).resolves.toBeDefined();
  });
});
