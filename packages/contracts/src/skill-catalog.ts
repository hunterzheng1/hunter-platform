import { z } from "zod";

export const skillCatalogItemKeySchema = z.string()
  .min(3)
  .max(220)
  .regex(/^(?:registry|external):[A-Za-z0-9][A-Za-z0-9._-]*$/);

export const skillCatalogOrderSchema = z.object({
  items: z.array(skillCatalogItemKeySchema).max(10_000),
  revision: z.number().int().nonnegative(),
  updated_at: z.iso.datetime().nullable()
}).strict();

export const updateSkillCatalogOrderRequestSchema = z.object({
  items: z.array(skillCatalogItemKeySchema).max(10_000)
    .refine((items) => new Set(items).size === items.length, "catalog order items must be unique"),
  revision: z.number().int().nonnegative()
}).strict();

export type SkillCatalogOrder = z.infer<typeof skillCatalogOrderSchema>;
export type UpdateSkillCatalogOrderRequest = z.infer<typeof updateSkillCatalogOrderRequestSchema>;
