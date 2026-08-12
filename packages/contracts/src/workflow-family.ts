import { z } from "zod";

import { sha256Schema } from "./protocol.js";
import {
  npmReleaseRecordSchema,
  registrySemverSchema,
  registrySlugSchema,
  skillCheckResultSchema,
  sourceFileSchema
} from "./registry.js";

export const workflowBundleManifestSchema = z.object({
  schema_version: z.literal(1),
  profile: registrySlugSchema,
  files: z.array(z.object({
    path: z.string().min(1),
    sha256: sha256Schema
  }).strict()).min(1)
}).strict();

export const workflowFamilyBundleArtifactSchema = z.object({
  artifact_id: z.string().regex(/^wfb_/),
  family_slug: registrySlugSchema,
  profile: registrySlugSchema,
  version: registrySemverSchema,
  content_sha256: sha256Schema,
  size_bytes: z.number().int().nonnegative(),
  bundle_manifest: workflowBundleManifestSchema,
  created_at: z.iso.datetime()
}).strict();

export const workflowFamilyVersionProfileSchema = z.object({
  profile: registrySlugSchema,
  bundle_manifest: workflowBundleManifestSchema,
  artifact_id: z.string().regex(/^wfb_/),
  sourceFiles: z.array(sourceFileSchema).default([])
}).strict();

export const workflowFamilyVersionSchema = z.object({
  family_slug: registrySlugSchema,
  version: registrySemverSchema,
  source_digest: sha256Schema.optional(),
  profiles: z.array(workflowFamilyVersionProfileSchema).min(1),
  artifacts: z.array(workflowFamilyBundleArtifactSchema),
  changeNote: z.string().nullable(),
  created_at: z.iso.datetime()
}).strict();

export const workflowFamilyVersionProfileSummarySchema = z.object({
  profile: registrySlugSchema,
  bundle_manifest: workflowBundleManifestSchema,
  artifact_id: z.string().regex(/^wfb_/),
  file_count: z.number().int().nonnegative()
}).strict();

export const workflowFamilyVersionSummarySchema = z.object({
  family_slug: registrySlugSchema,
  version: registrySemverSchema,
  profiles: z.array(workflowFamilyVersionProfileSummarySchema).min(1),
  artifacts: z.array(workflowFamilyBundleArtifactSchema),
  changeNote: z.string().nullable(),
  created_at: z.iso.datetime()
}).strict();

export const workflowFamilyDraftProfileSchema = z.object({
  profile: registrySlugSchema,
  sourceFiles: z.array(sourceFileSchema),
  bundle_manifest: workflowBundleManifestSchema
}).strict();

export const workflowFamilyDraftStateSchema = z.object({
  family_slug: registrySlugSchema,
  source_digest: sha256Schema.optional(),
  profiles: z.array(workflowFamilyDraftProfileSchema),
  required_profiles: z.array(registrySlugSchema),
  draftVersion: registrySemverSchema.nullable(),
  checks: skillCheckResultSchema.nullable(),
  releaseNote: z.string().nullable(),
  revision: z.number().int(),
  created_at: z.string(),
  updated_at: z.string()
}).strict();

export const workflowFamilyDraftProfileSummarySchema = z.object({
  profile: registrySlugSchema,
  file_count: z.number().int().nonnegative()
}).strict();

/**
 * Public draft metadata. Source contents stay in artifact storage and are
 * intentionally excluded from list/detail/import responses and idempotency
 * records.
 */
export const workflowFamilyDraftSummarySchema = z.object({
  family_slug: registrySlugSchema,
  profiles: z.array(workflowFamilyDraftProfileSummarySchema),
  required_profiles: z.array(registrySlugSchema),
  draftVersion: registrySemverSchema.nullable(),
  checks: skillCheckResultSchema.nullable(),
  releaseNote: z.string().nullable(),
  revision: z.number().int(),
  created_at: z.string(),
  updated_at: z.string()
}).strict();

export const workflowFamilySourceSchema = z.object({
  type: z.enum(["npm", "github"]),
  ref: z.string().min(1).max(1000)
}).strict();

export const workflowFamilySchema = z.object({
  family_id: z.string().regex(/^wff_/),
  slug: registrySlugSchema,
  displayName: z.string().min(1).max(120),
  description: z.string().min(1).max(1000),
  tags: z.array(registrySlugSchema).default([]),
  latest_version: registrySemverSchema.nullable(),
  required_profiles: z.array(registrySlugSchema).min(1),
  revision: z.number().int().positive(),
  npmReleases: z.array(npmReleaseRecordSchema).optional().default([]),
  source: workflowFamilySourceSchema.optional(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime()
}).strict();

export const workflowFamilyMutationSchema = z.object({
  slug: registrySlugSchema,
  displayName: z.string().min(1).max(120),
  description: z.string().min(1).max(1000),
  tags: z.array(registrySlugSchema).default([]),
  required_profiles: z.array(registrySlugSchema).min(1),
  source: workflowFamilySourceSchema.optional()
}).strict();

export const inspectWorkflowFamilySourceRequestSchema = z.object({
  schema_version: z.literal(1),
  source: workflowFamilySourceSchema
}).strict();

export const workflowFamilySourceProfileInspectionSchema = z.object({
  profile: registrySlugSchema,
  file_count: z.number().int().positive()
}).strict();

export const workflowFamilySourceInspectionSchema = z.object({
  source: workflowFamilySourceSchema,
  remote_version: registrySemverSchema.nullable(),
  source_digest: sha256Schema,
  manifest_detected: z.boolean(),
  ready: z.boolean(),
  suggested: z.object({
    slug: registrySlugSchema,
    displayName: z.string().min(1).max(120),
    description: z.string().min(1).max(1000),
    tags: z.array(registrySlugSchema)
  }).strict(),
  profiles: z.array(workflowFamilySourceProfileInspectionSchema),
  warnings: z.array(z.string())
}).strict();

export const importWorkflowFamilySourceRequestSchema = z.object({
  schema_version: z.literal(1),
  source: workflowFamilySourceSchema,
  source_digest: sha256Schema,
  slug: registrySlugSchema,
  displayName: z.string().min(1).max(120),
  description: z.string().min(1).max(1000),
  tags: z.array(registrySlugSchema).default([])
}).strict();

export const workflowFamilySourceImportResultSchema = z.object({
  family: workflowFamilySchema,
  draft: workflowFamilyDraftSummarySchema,
  inspection: workflowFamilySourceInspectionSchema
}).strict();

export const publishWorkflowFamilyRequestSchema = z.object({
  version: registrySemverSchema,
  releaseNote: z.string().optional()
}).strict();

export const registryProjectWorkflowBindingSchema = z.object({
  project_id: z.string().regex(/^prj_/),
  family_slug: registrySlugSchema,
  profile: registrySlugSchema,
  version: registrySemverSchema.nullable().optional(),
  revision: z.number().int().positive(),
  updated_at: z.iso.datetime()
}).strict();

export const bindProjectWorkflowFamilyRequestSchema = z.object({
  schema_version: z.literal(1),
  family_slug: registrySlugSchema,
  profile: registrySlugSchema,
  version: registrySemverSchema.nullable().optional(),
  revision: z.number().int().nullable()
}).strict();

export type WorkflowBundleManifest = z.infer<typeof workflowBundleManifestSchema>;
export type WorkflowFamilyBundleArtifact = z.infer<typeof workflowFamilyBundleArtifactSchema>;
export type WorkflowFamilyVersionProfile = z.infer<typeof workflowFamilyVersionProfileSchema>;
export type WorkflowFamilyVersion = z.infer<typeof workflowFamilyVersionSchema>;
export type WorkflowFamilyVersionProfileSummary = z.infer<typeof workflowFamilyVersionProfileSummarySchema>;
export type WorkflowFamilyVersionSummary = z.infer<typeof workflowFamilyVersionSummarySchema>;
export type WorkflowFamilyDraftProfile = z.infer<typeof workflowFamilyDraftProfileSchema>;
export type WorkflowFamilyDraftState = z.infer<typeof workflowFamilyDraftStateSchema>;
export type WorkflowFamilyDraftProfileSummary = z.infer<typeof workflowFamilyDraftProfileSummarySchema>;
export type WorkflowFamilyDraftSummary = z.infer<typeof workflowFamilyDraftSummarySchema>;
export type WorkflowFamily = z.infer<typeof workflowFamilySchema>;
export type WorkflowFamilyMutation = z.infer<typeof workflowFamilyMutationSchema>;
export type WorkflowFamilySource = z.infer<typeof workflowFamilySourceSchema>;
export type InspectWorkflowFamilySourceRequest = z.infer<typeof inspectWorkflowFamilySourceRequestSchema>;
export type WorkflowFamilySourceProfileInspection = z.infer<typeof workflowFamilySourceProfileInspectionSchema>;
export type WorkflowFamilySourceInspection = z.infer<typeof workflowFamilySourceInspectionSchema>;
export type ImportWorkflowFamilySourceRequest = z.infer<typeof importWorkflowFamilySourceRequestSchema>;
export type WorkflowFamilySourceImportResult = z.infer<typeof workflowFamilySourceImportResultSchema>;
export type PublishWorkflowFamilyRequest = z.infer<typeof publishWorkflowFamilyRequestSchema>;
export type RegistryProjectWorkflowBinding = z.infer<typeof registryProjectWorkflowBindingSchema>;
export type BindProjectWorkflowFamilyRequest = z.infer<typeof bindProjectWorkflowFamilyRequestSchema>;
