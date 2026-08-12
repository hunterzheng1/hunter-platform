import { z } from "zod";

import { registrySlugSchema } from "./registry.js";

export const agentToolCategorySchema = z.enum([
  "harness",
  "runtime",
  "orchestrator",
  "ade",
  "cli",
  "framework"
]);

export const agentToolStatusSchema = z.enum(["active", "experimental", "archived"]);

export const agentToolSourceSchema = z.object({
  type: z.enum(["github", "npm", "website"]),
  // Keep the exact source entered by the curator. In particular, GitHub
  // /tree/<branch>/<subpath> references must not collapse to the repo root.
  ref: z.string().trim().min(1).max(1000)
}).strict();

export const agentToolSchema = z.object({
  tool_id: z.string().regex(/^atl_/),
  slug: registrySlugSchema,
  displayName: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(1200),
  category: agentToolCategorySchema,
  status: agentToolStatusSchema,
  source: agentToolSourceSchema,
  homepage: z.url().nullable().default(null),
  packageName: z.string().trim().min(1).max(220).nullable().default(null),
  installCommand: z.string().trim().min(1).max(500).nullable().default(null),
  tags: z.array(registrySlugSchema).default([]),
  relatedWorkflowFamilies: z.array(registrySlugSchema).default([]),
  revision: z.number().int().positive(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime()
}).strict();

export const agentToolMutationSchema = z.object({
  slug: registrySlugSchema,
  displayName: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(1200),
  category: agentToolCategorySchema,
  status: agentToolStatusSchema.default("active"),
  source: agentToolSourceSchema,
  homepage: z.url().nullable().optional(),
  packageName: z.string().trim().min(1).max(220).nullable().optional(),
  installCommand: z.string().trim().min(1).max(500).nullable().optional(),
  tags: z.array(registrySlugSchema).default([]),
  relatedWorkflowFamilies: z.array(registrySlugSchema).default([])
}).strict();

export type AgentToolCategory = z.infer<typeof agentToolCategorySchema>;
export type AgentToolStatus = z.infer<typeof agentToolStatusSchema>;
export type AgentToolSource = z.infer<typeof agentToolSourceSchema>;
export type AgentTool = z.infer<typeof agentToolSchema>;
export type AgentToolMutation = z.infer<typeof agentToolMutationSchema>;
