import { z } from "zod";

export const nonEmptyTextSchema = z.string().trim().min(1);
export const pathTextSchema = nonEmptyTextSchema.refine(
  (path) => !path.includes("\0"),
  "Path contains a null byte",
);
export const agentNameSchema = nonEmptyTextSchema
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/i, "Agent names use letters, digits and hyphens");
const nonEmptyText = nonEmptyTextSchema;
const pathText = pathTextSchema;
const agentName = agentNameSchema;
const modelName = nonEmptyTextSchema.max(200);

export const taskStatusSchema = z.enum([
  "queued",
  "running",
  "blocked",
  "reviewing",
  "succeeded",
  "failed",
  "cancelled",
]);

export const executionModeValueSchema = z.enum(["dispatch", "mutual-check", "workflow"]);
export const budgetSchema = z.object({
  maxInputTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  maxCostMicros: z.number().int().nonnegative(),
});

// Aliases stay in the input schema because MCP tool schemas cannot contain transforms.
// The orchestrator normalizes them before persistence.
export const executionModeInputSchema = z.enum([
  "dispatch",
  "mutual-check",
  "mutual_check",
  "cross-check",
  "workflaw",
  "workflow",
]);
export const executionModeSchema = executionModeInputSchema.default("dispatch");

export function normalizeExecutionMode(
  mode: z.infer<typeof executionModeInputSchema>,
): ExecutionMode {
  if (mode === "dispatch") return "dispatch";
  if (mode === "workflow" || mode === "workflaw") return "workflow";
  return "mutual-check";
}

export const agentRefSchema = z.object({
  agent: agentName,
  model: modelName.optional(),
});

export const contextEnvelopeSchema = z.object({
  summary: nonEmptyText,
  decisions: z.array(z.object({ choice: nonEmptyText, reason: nonEmptyText })).default([]),
  evidence: z.array(z.object({ source: nonEmptyText, fact: nonEmptyText })).default([]),
  openQuestions: z.array(nonEmptyText).default([]),
});

export const taskSpecSchema = z
  .object({
    version: z.literal(1),
    objective: nonEmptyText,
    allowedPaths: z.array(pathText).min(1),
    excludedPaths: z.array(pathText).default([]),
    acceptance: z.array(nonEmptyText).min(1),
    workerProfile: nonEmptyText,
    worker: agentRefSchema.optional(),
    reviewers: z.array(agentRefSchema).max(8).default([]),
    mode: executionModeSchema,
    sourceTaskId: z.uuid().optional(),
    budget: budgetSchema,
    timeoutMs: z.number().int().min(100).max(86_400_000),
    context: contextEnvelopeSchema,
  })
  .superRefine((spec, context) => {
    const mode = normalizeExecutionMode(spec.mode);
    if (mode === "dispatch") {
      if (spec.reviewers.length > 0) {
        context.addIssue({
          code: "custom",
          path: ["reviewers"],
          message: "reviewers require mutual-check or workflow mode",
        });
      }
      if (spec.sourceTaskId) {
        context.addIssue({
          code: "custom",
          path: ["sourceTaskId"],
          message: "sourceTaskId is only valid in mutual-check mode",
        });
      }
      if (spec.acceptance.includes("mutual-check")) {
        context.addIssue({
          code: "custom",
          path: ["acceptance"],
          message: "mutual-check acceptance requires mutual-check or workflow mode",
        });
      }
      return;
    }

    if (spec.reviewers.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["reviewers"],
        message: `${mode} mode requires at least one reviewer`,
      });
    }

    if (!spec.acceptance.includes("mutual-check")) {
      context.addIssue({
        code: "custom",
        path: ["acceptance"],
        message: `${mode} mode requires mutual-check acceptance`,
      });
    }

    if (mode === "workflow" && !spec.acceptance.includes("generated-file-scope")) {
      context.addIssue({
        code: "custom",
        path: ["acceptance"],
        message: "workflow mode requires generated-file-scope acceptance for dispatch",
      });
    }

    const supported =
      mode === "workflow"
        ? new Set(["generated-file-scope", "mutual-check"])
        : new Set(["mutual-check"]);
    for (const [index, requirement] of spec.acceptance.entries()) {
      if (!supported.has(requirement)) {
        context.addIssue({
          code: "custom",
          path: ["acceptance", index],
          message: `${mode} mode does not implement acceptance: ${requirement}`,
        });
      }
    }

    const identities = new Set<string>();
    for (const [index, reviewer] of spec.reviewers.entries()) {
      const identity = `${reviewer.agent}\0${reviewer.model ?? ""}`;
      if (identities.has(identity)) {
        context.addIssue({
          code: "custom",
          path: ["reviewers", index],
          message: "Duplicate reviewer identity",
        });
      }
      identities.add(identity);
    }

    if (mode === "mutual-check" && !spec.sourceTaskId) {
      context.addIssue({
        code: "custom",
        path: ["sourceTaskId"],
        message: "mutual-check mode requires sourceTaskId",
      });
    }

    if (mode === "workflow" && spec.sourceTaskId) {
      context.addIssue({
        code: "custom",
        path: ["sourceTaskId"],
        message: "workflow mode checks its own dispatch result; omit sourceTaskId",
      });
    }
  });

export const artifactSchema = z.object({
  kind: z.enum(["patch", "commit", "test-report", "log", "source"]),
  uri: nonEmptyText,
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});

export const checkResultSchema = z.object({
  name: nonEmptyText,
  outcome: z.enum(["passed", "failed", "skipped"]),
  evidence: nonEmptyText.optional(),
});

export const reviewFindingSchema = z.object({
  severity: z.enum(["info", "warning", "blocker"]),
  message: nonEmptyText.max(2_000),
  evidence: nonEmptyText.max(2_000).optional(),
});

export const reviewRoundSchema = z.object({
  round: z.number().int().min(1).max(2),
  verdict: z.enum(["pass", "fail"]),
  summary: nonEmptyText.max(4_000),
  findings: z.array(reviewFindingSchema).max(50).default([]),
});

export const reviewSchema = z.object({
  reviewer: nonEmptyText,
  model: nonEmptyText.optional(),
  rounds: z.array(reviewRoundSchema).min(1).max(2),
  verdict: z.enum(["pass", "fail"]),
});

export const attemptResultSchema = z.object({
  status: z.enum(["succeeded", "failed", "blocked"]),
  summary: nonEmptyText,
  artifacts: z.array(artifactSchema),
  checks: z.array(checkResultSchema),
  reviews: z.array(reviewSchema).optional(),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    costMicros: z.number().int().nonnegative(),
    measured: z.boolean().optional(),
  }),
  error: z
    .object({
      code: nonEmptyText,
      retryable: z.boolean(),
      message: nonEmptyText,
    })
    .optional(),
});

export const agentDescriptorSchema = z.object({
  name: nonEmptyText,
  kind: nonEmptyText,
  profiles: z.array(nonEmptyText).min(1),
  available: z.boolean(),
  defaultModel: nonEmptyText.optional(),
  reason: nonEmptyText.optional(),
});

export const capabilityCatalogSchema = z.object({
  defaultMode: executionModeValueSchema,
  modes: z.array(executionModeValueSchema),
  agents: z.array(agentDescriptorSchema),
});

export const taskRecordSchema = z.object({
  id: z.uuid(),
  idempotencyKey: nonEmptyText,
  status: taskStatusSchema,
  spec: taskSpecSchema,
  revision: z.number().int().nonnegative(),
  attemptCount: z.number().int().nonnegative(),
  cancellationRequested: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  attemptId: z.uuid().optional(),
  provider: nonEmptyText.optional(),
  workerId: nonEmptyText.optional(),
  leaseOwner: nonEmptyText.optional(),
  leaseExpiresAt: z.iso.datetime().optional(),
  result: attemptResultSchema.optional(),
});

export const submitTaskInputSchema = z.object({
  idempotencyKey: nonEmptyText.max(200),
  task: taskSpecSchema,
});

export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type Budget = z.infer<typeof budgetSchema>;
export type ContextEnvelope = z.infer<typeof contextEnvelopeSchema>;
export type TaskSpec = z.infer<typeof taskSpecSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type AgentRef = z.infer<typeof agentRefSchema>;
export type ExecutionMode = z.infer<typeof executionModeValueSchema>;
export type Review = z.infer<typeof reviewSchema>;
export type ReviewRound = z.infer<typeof reviewRoundSchema>;
export type AttemptResult = z.infer<typeof attemptResultSchema>;
export type TaskRecord = z.infer<typeof taskRecordSchema>;
export type CapabilityCatalog = z.infer<typeof capabilityCatalogSchema>;
export type AgentDescriptor = z.infer<typeof agentDescriptorSchema>;
// Accept schema defaults and aliases at the public boundary; parse before persistence.
export type SubmitTaskInput = z.input<typeof submitTaskInputSchema>;
