import { z } from "zod";

import {
  agentNameSchema,
  budgetSchema,
  executionModeInputSchema,
  executionModeValueSchema,
  nonEmptyTextSchema,
  taskSpecSchema,
} from "./schemas.js";

export const artifactNameSchema = z
  .string()
  .trim()
  .regex(/^[a-zA-Z0-9_-]+\.(cpp|txt|md)$/, "Use one plain .cpp, .txt or .md filename");

export const workKindSchema = z.enum(["code", "document", "analysis", "review", "other"]);
export const workRiskSchema = z.enum(["low", "medium", "high"]);
export const workAmbiguitySchema = z.enum(["low", "medium", "high"]);
export const workReviewOwnerSchema = z.enum(["auto", "manager", "harness"]);
export const workStrategySchema = z.enum([
  "dispatch",
  "supervised",
  "cross-check",
  "review-only",
  "blocked",
]);

// The manager supplies signals, not a mode choice. The planner turns them into
// a deterministic packet; ambiguous or unsafe requests become blocked packets.
export const workRequestSchema = z.object({
  instruction: nonEmptyTextSchema.max(20_000),
  taskKind: workKindSchema.default("other"),
  artifactName: artifactNameSchema.optional(),
  risk: workRiskSchema.default("medium"),
  ambiguity: workAmbiguitySchema.default("medium"),
  requiresIndependentVerification: z.boolean().default(false),
  requestedMode: executionModeInputSchema.optional(),
  reviewBy: workReviewOwnerSchema.default("auto"),
  preferredWorker: agentNameSchema.optional(),
  preferredReviewers: z.array(agentNameSchema).max(8).default([]),
  sourceTaskId: z.uuid().optional(),
  managerCanPlan: z.boolean().default(true),
  managerCanReview: z.boolean().default(true),
  budget: budgetSchema.optional(),
  timeoutMs: z.number().int().min(100).max(86_400_000).optional(),
  contextSummary: nonEmptyTextSchema.max(20_000).optional(),
});

export const workPhaseSchema = z.object({
  id: z.enum(["design", "dispatch", "verify", "replan", "unblock"]),
  actor: z.enum(["manager", "mcp"]),
  action: z.enum(["design", "dispatch", "verify", "mutual-check", "replan", "unblock"]),
  tool: nonEmptyTextSchema.optional(),
  inputs: z.array(nonEmptyTextSchema).default([]),
  outputs: z.array(nonEmptyTextSchema).default([]),
  required: z.boolean().default(true),
  description: nonEmptyTextSchema,
});

export const workSignalFactorSchema = z.object({
  name: nonEmptyTextSchema,
  value: z.number(),
  reason: nonEmptyTextSchema,
});

export const workSignalsSchema = z.object({
  score: z.number().int(),
  risk: workRiskSchema,
  ambiguity: workAmbiguitySchema,
  taskKind: workKindSchema,
  requiresIndependentVerification: z.boolean(),
  reviewerCount: z.number().int().nonnegative(),
  factors: z.array(workSignalFactorSchema).default([]),
});

export const workDecisionSchema = z.object({
  strategy: workStrategySchema,
  taskMode: executionModeValueSchema.optional(),
  reason: nonEmptyTextSchema,
  matchedRule: nonEmptyTextSchema,
  confidence: z.enum(["low", "medium", "high"]),
  signals: workSignalsSchema,
});

export const workRolesSchema = z.object({
  planner: nonEmptyTextSchema,
  worker: agentNameSchema.optional(),
  reviewers: z.array(agentNameSchema).default([]),
  verifier: nonEmptyTextSchema,
});

export const workPacketSchema = z.object({
  version: z.literal(1),
  planId: z.uuid(),
  planHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.iso.datetime(),
  request: workRequestSchema,
  decision: workDecisionSchema,
  roles: workRolesSchema,
  phases: z.array(workPhaseSchema).min(1),
  taskTemplate: taskSpecSchema.optional(),
  managerInstructions: z.array(nonEmptyTextSchema).min(1),
  stopConditions: z.array(nonEmptyTextSchema).min(1),
  escalation: z.array(nonEmptyTextSchema).default([]),
});

export type WorkRequest = z.infer<typeof workRequestSchema>;
export type WorkPacket = z.infer<typeof workPacketSchema>;
export type WorkPhase = z.infer<typeof workPhaseSchema>;
export type WorkStrategy = z.infer<typeof workStrategySchema>;
export type WorkReviewOwner = z.infer<typeof workReviewOwnerSchema>;
export type WorkTaskMode = z.infer<typeof executionModeValueSchema>;
export type WorkSignals = z.infer<typeof workSignalsSchema>;
export type WorkDecision = z.infer<typeof workDecisionSchema>;
export type WorkRoles = z.infer<typeof workRolesSchema>;
