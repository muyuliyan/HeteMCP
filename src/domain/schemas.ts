import { z } from "zod";

const nonEmptyText = z.string().trim().min(1);
const pathText = nonEmptyText.refine((path) => !path.includes("\0"), "Path contains a null byte");

export const taskStatusSchema = z.enum([
  "queued",
  "running",
  "blocked",
  "reviewing",
  "succeeded",
  "failed",
  "cancelled",
]);

export const contextEnvelopeSchema = z.object({
  summary: nonEmptyText,
  decisions: z.array(z.object({ choice: nonEmptyText, reason: nonEmptyText })).default([]),
  evidence: z.array(z.object({ source: nonEmptyText, fact: nonEmptyText })).default([]),
  openQuestions: z.array(nonEmptyText).default([]),
});

export const taskSpecSchema = z.object({
  version: z.literal(1),
  objective: nonEmptyText,
  allowedPaths: z.array(pathText).min(1),
  excludedPaths: z.array(pathText).default([]),
  acceptance: z.array(nonEmptyText).min(1),
  workerProfile: nonEmptyText,
  budget: z.object({
    maxInputTokens: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
    maxCostMicros: z.number().int().nonnegative(),
  }),
  timeoutMs: z.number().int().min(100).max(86_400_000),
  context: contextEnvelopeSchema,
});

export const artifactSchema = z.object({
  kind: z.enum(["patch", "commit", "test-report", "log"]),
  uri: nonEmptyText,
});

export const checkResultSchema = z.object({
  name: nonEmptyText,
  outcome: z.enum(["passed", "failed", "skipped"]),
  evidence: nonEmptyText.optional(),
});

export const attemptResultSchema = z.object({
  status: z.enum(["succeeded", "failed", "blocked"]),
  summary: nonEmptyText,
  artifacts: z.array(artifactSchema),
  checks: z.array(checkResultSchema),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    costMicros: z.number().int().nonnegative(),
  }),
  error: z
    .object({
      code: nonEmptyText,
      retryable: z.boolean(),
      message: nonEmptyText,
    })
    .optional(),
});

export const taskRecordSchema = z.object({
  id: z.uuid(),
  idempotencyKey: nonEmptyText,
  status: taskStatusSchema,
  spec: taskSpecSchema,
  revision: z.number().int().nonnegative(),
  cancellationRequested: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  attemptId: z.uuid().optional(),
  provider: nonEmptyText.optional(),
  result: attemptResultSchema.optional(),
});

export const submitTaskInputSchema = z.object({
  idempotencyKey: nonEmptyText.max(200),
  task: taskSpecSchema,
});

export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type ContextEnvelope = z.infer<typeof contextEnvelopeSchema>;
export type TaskSpec = z.infer<typeof taskSpecSchema>;
export type AttemptResult = z.infer<typeof attemptResultSchema>;
export type TaskRecord = z.infer<typeof taskRecordSchema>;
export type SubmitTaskInput = z.infer<typeof submitTaskInputSchema>;
