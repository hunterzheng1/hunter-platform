import { z } from "zod";

import { sha256Schema } from "./protocol.js";

export const externalSkillSourceTypeSchema = z.enum(["npm", "github"]);
export type ExternalSkillSourceType = z.infer<typeof externalSkillSourceTypeSchema>;

export const externalSkillSourceSchema = z.object({
  type: externalSkillSourceTypeSchema,
  /** npm 包名，或规范化后的 `owner/repo` */
  ref: z.string().min(1)
}).strict();
export type ExternalSkillSource = z.infer<typeof externalSkillSourceSchema>;

export const externalSkillSnapshotSchema = z.object({
  name: z.string(),
  description: z.string(),
  version: z.string().nullable(),
  readme: z.string().nullable(),
  installCommand: z.string(),
  license: z.string().nullable(),
  homepage: z.string().nullable(),
  releaseUrl: z.string().nullable(),
  fetchedAt: z.string()
}).strict();
export type ExternalSkillSnapshot = z.infer<typeof externalSkillSnapshotSchema>;

export const externalSkillQuickStartStepSchema = z.object({
  title: z.string().trim().min(1).max(120),
  instruction: z.string().trim().min(1).max(400),
  commands: z.array(z.string().trim().min(1).max(500)).max(8)
}).strict();
export type ExternalSkillQuickStartStep = z.infer<typeof externalSkillQuickStartStepSchema>;

export const externalSkillSummaryContentSchema = z.object({
  overview: z.string().trim().min(1).max(2_000),
  use_cases: z.array(z.string().trim().min(1).max(300)).min(1).max(6),
  capabilities: z.array(z.string().trim().min(1).max(300)).min(1).max(8),
  /** 结构化快速上手；旧摘要仍可只提供 getting_started。 */
  quick_start: z.array(externalSkillQuickStartStepSchema).max(6).optional(),
  getting_started: z.array(z.string().trim().min(1).max(300)).max(6),
  caveats: z.array(z.string().trim().min(1).max(300)).max(6)
}).strict();
export type ExternalSkillSummaryContent = z.infer<typeof externalSkillSummaryContentSchema>;

export const externalSkillAiSummarySchema = externalSkillSummaryContentSchema.extend({
  source_sha256: sha256Schema,
  provider_id: z.string().min(1),
  model: z.string().min(1),
  generated_at: z.iso.datetime()
}).strict();
export type ExternalSkillAiSummary = z.infer<typeof externalSkillAiSummarySchema>;

export const externalSkillSchema = z.object({
  id: z.string().regex(/^ext_/),
  source: externalSkillSourceSchema,
  snapshot: externalSkillSnapshotSchema,
  /** 按上游名称、description 与 README 生成并缓存；旧快照允许缺省。 */
  aiSummary: externalSkillAiSummarySchema.nullable().optional(),
  curationNote: z.string(),
  tags: z.array(z.string()),
  updateAvailable: z.boolean(),
  lastCheckedAt: z.string(),
  revision: z.number().int().positive(),
  created_at: z.string(),
  updated_at: z.string()
}).strict();
export type ExternalSkill = z.infer<typeof externalSkillSchema>;

export const generateExternalSkillSummaryRequestSchema = z.object({
  revision: z.number().int().positive(),
  force: z.boolean().default(false)
}).strict();
export type GenerateExternalSkillSummaryRequest = z.infer<typeof generateExternalSkillSummaryRequestSchema>;

export const createExternalSkillRequestSchema = z.object({
  source: externalSkillSourceSchema,
  curationNote: z.string().default(""),
  tags: z.array(z.string()).default([])
}).strict();
export type CreateExternalSkillRequest = z.infer<typeof createExternalSkillRequestSchema>;

export const patchExternalSkillRequestSchema = z.object({
  curationNote: z.string().optional(),
  tags: z.array(z.string()).optional(),
  /** 清除「有更新」徽章（不改变 curationNote / snapshot） */
  acknowledgeUpdate: z.boolean().optional(),
  revision: z.number().int().positive()
}).strict();
export type PatchExternalSkillRequest = z.infer<typeof patchExternalSkillRequestSchema>;
