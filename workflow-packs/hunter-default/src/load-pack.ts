import { existsSync, readFileSync } from "node:fs";

import { createWorkflowRevision, deepFreeze, type WorkflowRevision } from "@hunter/domain";
import { z } from "zod";

const HunterDefaultWorkflowIdSchema = z.enum([
  "hunter.change-delivery",
  "hunter.task-delivery",
]);

const WorkflowAssetSchema = z
  .object({
    workflowId: HunterDefaultWorkflowIdSchema,
    revision: z.unknown(),
  })
  .strict();

export type HunterDefaultWorkflowId = z.infer<typeof HunterDefaultWorkflowIdSchema>;

export type HunterDefaultWorkflow = Readonly<
  WorkflowRevision & { readonly workflowId: HunterDefaultWorkflowId }
>;

export interface HunterDefaultPack {
  readonly packId: "hunter-default";
  readonly version: "1.0.0";
  readonly workflows: readonly HunterDefaultWorkflow[];
}

function assetUrl(name: string): URL {
  const candidates = [new URL(name, import.meta.url), new URL(`../${name}`, import.meta.url)];
  const match = candidates.find((candidate) => existsSync(candidate));
  if (match === undefined) throw new Error(`WORKFLOW_ASSET_NOT_FOUND: ${name}`);
  return match;
}

function readWorkflow(name: string): HunterDefaultWorkflow {
  const asset = WorkflowAssetSchema.parse(JSON.parse(readFileSync(assetUrl(name), "utf8")));
  const revision = createWorkflowRevision(asset.revision);
  return deepFreeze({ workflowId: asset.workflowId, ...revision });
}

export function loadHunterDefaultPack(): Readonly<HunterDefaultPack> {
  return deepFreeze({
    packId: "hunter-default",
    version: "1.0.0",
    workflows: [
      readWorkflow("change-delivery.v1.json"),
      readWorkflow("task-delivery.v1.json"),
    ],
  });
}
