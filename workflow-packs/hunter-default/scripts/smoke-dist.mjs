import { access, readFile } from "node:fs/promises";
import { URL } from "node:url";

const assetNames = ["change-delivery.v1.json", "task-delivery.v1.json"];

await Promise.all(
  assetNames.map(async (assetName) => {
    const assetUrl = new URL(`../dist/${assetName}`, import.meta.url);
    await access(assetUrl);
    JSON.parse(await readFile(assetUrl, "utf8"));
  }),
);

const publicApi = await import("../dist/index.js");
if ("parseWorkflowAsset" in publicApi || "createHunterDefaultPack" in publicApi) {
  throw new Error("INTERNAL_WORKFLOW_HELPER_EXPORTED");
}

const pack = publicApi.loadHunterDefaultPack();
const workflowIds = pack.workflows.map(({ workflowId }) => workflowId).sort();
if (workflowIds.join(",") !== "hunter.change-delivery,hunter.task-delivery") {
  throw new Error("DIST_WORKFLOW_IDENTITIES_INVALID");
}
