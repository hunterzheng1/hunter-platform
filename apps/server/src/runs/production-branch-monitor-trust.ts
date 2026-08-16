import { createHash } from "node:crypto";

import { readPlanEventBundle } from "@hunter-harness/contracts";

import { createBranchMonitorCursorPort } from "./branch-monitor-cursor.js";
import type { CreateServerOptions } from "../app.js";

export function createProductionBranchMonitorTrust(
  cursorSecret: string | undefined
): CreateServerOptions["branchMonitorTrust"] {
  if (cursorSecret === undefined) return undefined;
  const cursorPort = createBranchMonitorCursorPort(cursorSecret);
  return {
    cursorPort,
    eventBundleReader: {
      readEventBundle(serialized) {
        return readPlanEventBundle(serialized, {
          sha256(canonicalPayload) {
            return `sha256:${createHash("sha256").update(canonicalPayload, "utf8").digest("hex")}`;
          }
        });
      }
    }
  };
}
