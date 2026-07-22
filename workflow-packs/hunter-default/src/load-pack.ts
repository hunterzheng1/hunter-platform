import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

const WORKFLOW_REVISION_BY_ID: Readonly<Record<HunterDefaultWorkflowId, string>> = {
  "hunter.change-delivery": "wfr_hunter_change_delivery_v1",
  "hunter.task-delivery": "wfr_hunter_task_delivery_v1",
};

function assetPath(name: string): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const moduleKind = basename(moduleDirectory);
  if (moduleKind === "src") return join(moduleDirectory, "..", name);
  if (moduleKind === "dist") return join(moduleDirectory, name);
  throw new Error(`WORKFLOW_ASSET_MODULE_LOCATION_INVALID: ${moduleDirectory}`);
}

export function parseWorkflowAsset(input: unknown): HunterDefaultWorkflow {
  const asset = WorkflowAssetSchema.parse(input);
  const revision = createWorkflowRevision(asset.revision);
  if (revision.workflowRevisionId !== WORKFLOW_REVISION_BY_ID[asset.workflowId]) {
    throw new Error("WORKFLOW_ASSET_IDENTITY_MISMATCH");
  }
  return deepFreeze({ workflowId: asset.workflowId, ...revision });
}

function readWorkflow(name: string): HunterDefaultWorkflow {
  return parseWorkflowAsset(JSON.parse(readFileSync(assetPath(name), "utf8")));
}

export function createHunterDefaultPack(
  workflows: readonly HunterDefaultWorkflow[],
): Readonly<HunterDefaultPack> {
  const identities = new Set(workflows.map(({ workflowId }) => workflowId));
  if (workflows.length !== 2 || identities.size !== 2 || Object.keys(WORKFLOW_REVISION_BY_ID).some((id) => !identities.has(id as HunterDefaultWorkflowId))) {
    throw new Error("WORKFLOW_PACK_IDENTITIES_INVALID");
  }
  const orderedWorkflows = [
    workflows.find(({ workflowId }) => workflowId === "hunter.change-delivery")!,
    workflows.find(({ workflowId }) => workflowId === "hunter.task-delivery")!,
  ];
  return deepFreeze({
    packId: "hunter-default",
    version: "1.0.0",
    workflows: orderedWorkflows,
  });
}

export function loadHunterDefaultPack(): Readonly<HunterDefaultPack> {
  return createHunterDefaultPack([
    readWorkflow("change-delivery.v1.json"),
    readWorkflow("task-delivery.v1.json"),
  ]);
}
