import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stringify as stringifyYaml } from "yaml";

import type { ProjectConfig } from "@hunter-harness/contracts";

import { writeBaseline } from "../../src/state/baseline.js";

export function testProjectConfig(): ProjectConfig {
  return {
    harness: { name: "hunter-harness", schema_version: 1 },
    project: {
      name: "fixture-project",
      root: ".",
      local_project_key: "018f1000-0000-7000-8000-000000000000",
      project_id: null,
      profiles: ["general"]
    },
    server: { url: null, token_env: "TEST_HUNTER_TOKEN" },
    adapters: { enabled: ["claude-code"] }
  };
}

/** v1 固定单一投影的受管根目录（与 push.ts SHARED_MANAGED_ROOTS 对应）。 */
const MANAGED_ROOTS = [
  ".harness/knowledge",
  ".harness/codebase",
  ".harness/rules"
];

/**
 * 最小受管项目脚手架（替代已删除的 initializeProject 夹具）：
 * project.yaml + 空 baseline manifest + 受管目录。
 */
export async function scaffoldTestProject(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(root, ".harness"), { recursive: true });
  await writeFile(
    join(root, ".harness", "project.yaml"),
    stringifyYaml(testProjectConfig(), { sortMapEntries: true }),
    "utf8"
  );
  await writeBaseline(root, {
    schema_version: 1,
    project_id: null,
    complete_project_version: null,
    artifact_manifest_hash: null,
    files: {}
  });
  for (const managedRoot of MANAGED_ROOTS) {
    await mkdir(join(root, ...managedRoot.split("/")), { recursive: true });
  }
  return root;
}
