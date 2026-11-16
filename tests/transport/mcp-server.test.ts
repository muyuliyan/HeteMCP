import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { Orchestrator } from "../../src/application/orchestrator.js";
import { taskRecordSchema } from "../../src/domain/schemas.js";
import { workPacketSchema } from "../../src/domain/work-packet.js";
import { FakeProvider } from "../../src/infrastructure/providers/fake-provider.js";
import { InMemoryTaskRepository } from "../../src/infrastructure/repositories/in-memory-task-repository.js";
import { createMcpServer } from "../../src/transport/mcp/server.js";
import { createTaskInput } from "../fixtures.js";

const taskResponseSchema = z.object({ task: taskRecordSchema });
const packetResponseSchema = z.object({ packet: workPacketSchema });

describe("MCP server", () => {
  const closeables: { close(): Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(closeables.splice(0).map((closeable) => closeable.close()));
  });

  it("executes a task through a real MCP client transport", async () => {
    const orchestrator = new Orchestrator(new InMemoryTaskRepository(), new FakeProvider());
    const server = createMcpServer(orchestrator);
    const client = new Client({ name: "heteromcp-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "cancel_task",
      "create_mutual_check",
      "create_task",
      "create_workflow",
      "execute_work_packet",
      "get_task",
      "get_task_result",
      "list_workers",
      "plan_work",
    ]);

    const catalogResponse = await client.callTool({ name: "list_workers", arguments: {} });
    expect(catalogResponse.structuredContent).toMatchObject({
      catalog: {
        defaultMode: "dispatch",
        agents: [expect.objectContaining({ name: "fake", available: true })],
      },
    });

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
    expect(current.result?.checks.every((check) => check.outcome === "passed")).toBe(true);
  });

  it("builds workflow and mutual-check tasks and rejects non-file sources", async () => {
    const orchestrator = new Orchestrator(new InMemoryTaskRepository(), new FakeProvider());
    const server = createMcpServer(orchestrator);
    const client = new Client({ name: "heteromcp-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const workflow = await client.callTool({
      name: "create_workflow",
      arguments: {
        idempotencyKey: "workflow-1",
        task: {
          ...createTaskInput().task,
          allowedPaths: ["note.txt"],
          excludedPaths: [],
          acceptance: ["generated-file-scope"],
        },
        reviewers: [{ agent: "fake" }],
      },
    });
    expect(workflow.isError).not.toBe(true);
    const workflowTask = taskResponseSchema.parse(workflow.structuredContent).task;
    expect(workflowTask.spec.mode).toBe("workflow");
    expect(workflowTask.spec.acceptance).toEqual(["generated-file-scope", "mutual-check"]);
    expect(workflowTask.spec.reviewers).toEqual([{ agent: "fake" }]);

    const sourceResponse = await client.callTool({
      name: "create_task",
      arguments: createTaskInput({ idempotencyKey: "source-1" }),
    });
    const source = taskResponseSchema.parse(sourceResponse.structuredContent).task;
    await orchestrator.runTask(source.id);

    const check = await client.callTool({
      name: "create_mutual_check",
      arguments: {
        idempotencyKey: "mutual-check-1",
        sourceTaskId: source.id,
        reviewers: [{ agent: "fake" }],
      },
    });
    expect(check.isError).toBe(true);
    expect(JSON.stringify(check.content)).toContain("SOURCE_TASK_NO_ARTIFACTS");
  });

  it("plans and executes a work packet, rejecting a tampered packet", async () => {
    const orchestrator = new Orchestrator(new InMemoryTaskRepository(), new FakeProvider());
    const server = createMcpServer(orchestrator);
    const client = new Client({ name: "heteromcp-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, server);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const planned = await client.callTool({
      name: "plan_work",
      arguments: {
        instruction: "Write a short release note",
        taskKind: "document",
        risk: "low",
        ambiguity: "low",
        preferredWorker: "fake",
      },
    });
    expect(planned.isError).not.toBe(true);
    const packet = packetResponseSchema.parse(planned.structuredContent).packet;
    expect(packet.decision.strategy).toBe("dispatch");
    expect(packet.roles.worker).toBe("fake");
    expect(packet.taskTemplate?.workerProfile).toBe("fake");

    const executed = await client.callTool({
      name: "execute_work_packet",
      arguments: {
        packet,
        idempotencyKey: "packet-1",
      },
    });
    expect(executed.isError).not.toBe(true);
    const task = taskResponseSchema.parse(executed.structuredContent).task;
    let current = task;
    for (let attempt = 0; attempt < 10 && current.status !== "succeeded"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const response = await client.callTool({
        name: "get_task_result",
        arguments: { taskId: task.id },
      });
      current = taskResponseSchema.parse(response.structuredContent).task;
    }
    expect(current.status).toBe("succeeded");

    const tampered = structuredClone(packet);
    if (!tampered.taskTemplate) throw new Error("expected a task template");
    tampered.taskTemplate.objective = "Tampered objective";
    const rejected = await client.callTool({
      name: "execute_work_packet",
      arguments: {
        packet: tampered,
        idempotencyKey: "packet-tampered",
      },
    });
    expect(rejected.isError).toBe(true);
    expect(JSON.stringify(rejected.content)).toContain("PACKET_INVALID");
  });
});
