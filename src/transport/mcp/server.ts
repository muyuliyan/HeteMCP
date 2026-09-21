import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { DomainError } from "../../domain/errors.js";
import { taskRecordSchema, taskSpecSchema } from "../../domain/schemas.js";
import type { Orchestrator } from "../../application/orchestrator.js";

const taskIdInput = { taskId: z.uuid().describe("HeteMCP task ID") };
const taskOutput = { task: taskRecordSchema };

function success(task: z.infer<typeof taskRecordSchema>) {
  const structuredContent = { task };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function failure(error: unknown) {
  const code = error instanceof DomainError ? error.code : "INTERNAL_ERROR";
  const message = error instanceof Error ? error.message : "Unknown error";
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ error: { code, message } }) }],
  };
}

export interface McpServerOptions {
  onBackgroundError?: (error: unknown) => void;
}

export function createMcpServer(
  orchestrator: Orchestrator,
  options: McpServerOptions = {},
): McpServer {
  const server = new McpServer({ name: "heteromcp", version: "0.1.0" });
  const onBackgroundError =
    options.onBackgroundError ??
    ((error: unknown) => console.error("Background task execution failed", error));

  server.registerTool(
    "create_task",
    {
      description: "Create an idempotent model-worker task and schedule it for execution.",
      inputSchema: {
        idempotencyKey: z.string().trim().min(1).max(200),
        task: taskSpecSchema,
      },
      outputSchema: taskOutput,
    },
    async (input) => {
      try {
        const task = await orchestrator.createTask(input);
        queueMicrotask(() => {
          void orchestrator.runTask(task.id).catch(onBackgroundError);
        });
        return success(task);
      } catch (error: unknown) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_task",
    {
      description: "Read current task state, attempt metadata, and result when available.",
      inputSchema: taskIdInput,
      outputSchema: taskOutput,
      annotations: { readOnlyHint: true },
    },
    async ({ taskId }) => {
      try {
        return success(await orchestrator.getTask(taskId));
      } catch (error: unknown) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "cancel_task",
    {
      description: "Request cancellation and return the resulting task state.",
      inputSchema: taskIdInput,
      outputSchema: taskOutput,
      annotations: { destructiveHint: true },
    },
    async ({ taskId }) => {
      try {
        return success(await orchestrator.cancelTask(taskId));
      } catch (error: unknown) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_task_result",
    {
      description: "Read the complete task record, including verified result artifacts and checks.",
      inputSchema: taskIdInput,
      outputSchema: taskOutput,
      annotations: { readOnlyHint: true },
    },
    async ({ taskId }) => {
      try {
        return success(await orchestrator.getTask(taskId));
      } catch (error: unknown) {
        return failure(error);
      }
    },
  );

  return server;
}
