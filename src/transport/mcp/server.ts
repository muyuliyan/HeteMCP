import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { DomainError } from "../../domain/errors.js";
import {
  agentRefSchema,
  capabilityCatalogSchema,
  taskRecordSchema,
  taskSpecSchema,
  type CapabilityCatalog,
} from "../../domain/schemas.js";
import type { Orchestrator } from "../../application/orchestrator.js";

const taskIdInput = { taskId: z.uuid().describe("HeteMCP task ID") };
const taskOutput = { task: taskRecordSchema };
const catalogOutput = { catalog: capabilityCatalogSchema };
const idempotencyKey = z.string().trim().min(1).max(200);
const reviewersInput = z
  .array(agentRefSchema)
  .min(1)
  .max(8)
  .describe('Reviewer models, for example [{"agent":"claude"},{"agent":"codex","model":"gpt-5"}]');

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

function schedule(orchestrator: Orchestrator, taskId: string, onError: (error: unknown) => void) {
  queueMicrotask(() => {
    void orchestrator.runTask(taskId).catch(onError);
  });
}

function fallbackCatalog(): CapabilityCatalog {
  return {
    defaultMode: "dispatch",
    modes: ["dispatch", "mutual-check", "workflow"],
    agents: [],
  };
}

export interface McpServerOptions {
  onBackgroundError?: (error: unknown) => void;
}

export function createMcpServer(
  orchestrator: Orchestrator,
  options: McpServerOptions = {},
): McpServer {
  const server = new McpServer({ name: "heteromcp", version: "0.2.0" });
  const onBackgroundError =
    options.onBackgroundError ??
    ((error: unknown) => console.error("Background task execution failed", error));

  server.registerTool(
    "create_task",
    {
      description:
        "Create an idempotent task. mode defaults to dispatch; use mutual-check with sourceTaskId or workflow to dispatch then cross-review.",
      inputSchema: {
        idempotencyKey,
        task: taskSpecSchema,
      },
      outputSchema: taskOutput,
    },
    async (input) => {
      try {
        const task = await orchestrator.createTask(input);
        schedule(orchestrator, task.id, onBackgroundError);
        return success(task);
      } catch (error: unknown) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "create_workflow",
    {
      description:
        "Create a workflow task: dispatch the task to its worker, then have the listed reviewers cross-check the generated artifact. Alias mode name: workflaw.",
      inputSchema: {
        idempotencyKey,
        task: taskSpecSchema,
        reviewers: reviewersInput,
      },
      outputSchema: taskOutput,
    },
    async (input) => {
      try {
        const spec = taskSpecSchema.parse({
          ...input.task,
          mode: "workflow",
          reviewers: input.reviewers,
          acceptance: [...new Set([...input.task.acceptance, "mutual-check"])],
        });
        const task = await orchestrator.createTask({
          idempotencyKey: input.idempotencyKey,
          task: spec,
        });
        schedule(orchestrator, task.id, onBackgroundError);
        return success(task);
      } catch (error: unknown) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "create_mutual_check",
    {
      description:
        "Create a mutual-check task for an existing task's artifacts. Reviewers inspect the source artifact and then each other's findings.",
      inputSchema: {
        idempotencyKey,
        sourceTaskId: z.uuid().describe("Completed or otherwise artifact-producing source task"),
        reviewers: reviewersInput,
        objective: z.string().trim().min(1).optional(),
        timeoutMs: z.number().int().min(100).max(86_400_000).optional(),
      },
      outputSchema: taskOutput,
    },
    async (input) => {
      try {
        const source = await orchestrator.getTask(input.sourceTaskId);
        if (!source.result || source.result.artifacts.length === 0) {
          throw new DomainError(
            "SOURCE_TASK_NO_ARTIFACTS",
            `Source task ${source.id} has no artifacts to review`,
          );
        }
        if (!source.result.artifacts.some((artifact) => artifact.uri.startsWith("file:"))) {
          throw new DomainError(
            "SOURCE_TASK_NO_ARTIFACTS",
            `Source task ${source.id} has no file-backed artifact to review`,
          );
        }
        const spec = taskSpecSchema.parse({
          version: 1,
          objective: input.objective ?? `Mutual check: ${source.spec.objective}`,
          allowedPaths: source.spec.allowedPaths,
          excludedPaths: [],
          acceptance: ["mutual-check"],
          workerProfile: "mutual-check",
          mode: "mutual-check",
          reviewers: input.reviewers,
          sourceTaskId: source.id,
          budget: source.spec.budget,
          timeoutMs: input.timeoutMs ?? source.spec.timeoutMs,
          context: {
            summary: source.spec.context.summary,
            decisions: source.spec.context.decisions,
            evidence: [
              { source: source.id, fact: `reviewing source task with status ${source.status}` },
            ],
            openQuestions: source.spec.context.openQuestions,
          },
        });
        const task = await orchestrator.createTask({
          idempotencyKey: input.idempotencyKey,
          task: spec,
        });
        schedule(orchestrator, task.id, onBackgroundError);
        return success(task);
      } catch (error: unknown) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "get_task",
    {
      description: "Read current task state, attempt metadata, mode, and result when available.",
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
      description:
        "Read the complete task record, including verified artifacts, checks and mutual-check reviews.",
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
    "list_workers",
    {
      description:
        "List execution modes and configured agents (Claude Code, Codex, DeepSeek Harness, fake).",
      outputSchema: catalogOutput,
      annotations: { readOnlyHint: true },
    },
    () => {
      const structuredContent = {
        catalog: orchestrator.capabilities() ?? fallbackCatalog(),
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    },
  );

  return server;
}
