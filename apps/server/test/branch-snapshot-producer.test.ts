import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createBranchSnapshotProducer,
  type BranchSnapshotCommitPort,
  type BranchSnapshotProducerInput,
} from "../src/branch-snapshots/index.js";

const digest = (value: string): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

function input(): BranchSnapshotProducerInput {
  const content = "# instructions\n";
  const files = [
    {
      path: "AGENTS.md",
      content_kind: "instruction" as const,
      size: Buffer.byteLength(content),
      content_hash: digest(content),
      media_type: "text/markdown" as const,
      action: "modify" as const,
      content,
    },
  ];
  const refs = files.map((entry) => ({
    path: entry.path,
    content_kind: entry.content_kind,
    size: entry.size,
    content_hash: entry.content_hash,
    media_type: entry.media_type,
    action: entry.action,
  }));
  return {
    schema_version: 1,
    actor_id: "actor_owner",
    idempotency_key: "snapshot_commit_0001",
    expected_revision: "revision_0001",
    source: {
      project_id: "prj_stage02",
      branch_name: "feature/contracts",
      actor_id: "actor_owner",
      commit_sha: "a".repeat(40),
      client_id: "cli_stage02",
      change_key: "change_stage02",
    },
    project_version: "pv_0002",
    artifact_id: "art_stage02_0002",
    manifest_hash: digest(JSON.stringify(refs)),
    diff_ref: "diff_stage02_0002",
    uploaded_at: "2026-08-15T01:00:00.000Z",
    changed_paths: ["AGENTS.md"],
    files,
  };
}

describe("BranchSnapshotProducer", () => {
  it("publishes an explicitly identified snapshot through the transaction-bound commit port", async () => {
    let observed: Parameters<BranchSnapshotCommitPort["commitSnapshot"]>[0] | undefined;
    const port: BranchSnapshotCommitPort = {
      async commitSnapshot(value) {
        observed = value;
        const record = {
          ...value.seed,
          files: value.seed.files.map((entry) => ({
            path: entry.path,
            content_kind: entry.content_kind,
            size: entry.size,
            content_hash: entry.content_hash,
            media_type: entry.media_type,
            ...(entry.action === undefined ? {} : { action: entry.action }),
          })),
        };
        return { outcome: "new", record };
      },
    };

    const result = await createBranchSnapshotProducer({ commit_port: port }).publish(input());

    expect(result.outcome).toBe("new");
    expect(result.record).toMatchObject({
      project_id: "prj_stage02",
      branch_name: "feature/contracts",
      commit_sha: "a".repeat(40),
      project_version: "pv_0002",
      artifact_id: "art_stage02_0002",
      changed_paths: ["AGENTS.md"],
    });
    expect(observed).toMatchObject({
      actor_id: "actor_owner",
      idempotency_key: "snapshot_commit_0001",
      expected_revision: "revision_0001",
      source: {
        project_id: "prj_stage02",
        branch_name: "feature/contracts",
        commit_sha: "a".repeat(40),
        client_id: "cli_stage02",
        change_key: "change_stage02",
      },
    });
  });

  it("returns no_changes without calling the commit port for an empty diff", async () => {
    let calls = 0;
    const port: BranchSnapshotCommitPort = {
      async commitSnapshot() {
        calls += 1;
        throw new Error("unreachable");
      },
    };
    const value = input();
    const first = value.files[0];
    if (first === undefined) throw new Error("fixture file missing");
    value.files[0] = { ...first, action: "no_change" };
    value.changed_paths = [];
    value.manifest_hash = digest(JSON.stringify(value.files.map((entry) => ({
      path: entry.path,
      content_kind: entry.content_kind,
      size: entry.size,
      content_hash: entry.content_hash,
      media_type: entry.media_type,
      action: entry.action,
    }))));

    await expect(createBranchSnapshotProducer({ commit_port: port }).publish(value)).resolves.toEqual({
      outcome: "no_changes",
    });
    expect(calls).toBe(0);
  });

  it("rejects missing commit identity and metadata instead of inferring legacy values", async () => {
    let calls = 0;
    const port: BranchSnapshotCommitPort = {
      async commitSnapshot() {
        calls += 1;
        throw new Error("unreachable");
      },
    };
    const value = input();
    delete value.source.commit_sha;

    await expect(createBranchSnapshotProducer({ commit_port: port }).publish(value)).rejects.toThrow(
      "BRANCH_SNAPSHOT_PRODUCER_INPUT_INVALID",
    );
    expect(calls).toBe(0);
  });

  it("rejects hostile request accessors without executing them", async () => {
    let reads = 0;
    const hostile = Object.defineProperty({}, "source", {
      enumerable: true,
      get() {
        reads += 1;
        return input().source;
      },
    });
    const port: BranchSnapshotCommitPort = {
      async commitSnapshot() {
        throw new Error("unreachable");
      },
    };

    await expect(
      createBranchSnapshotProducer({ commit_port: port }).publish(hostile as never),
    ).rejects.toThrow("BRANCH_SNAPSHOT_PRODUCER_INPUT_INVALID");
    expect(reads).toBe(0);
  });

  it("rejects hostile dependency accessors without executing them", () => {
    let reads = 0;
    const dependencies = Object.defineProperty({}, "commit_port", {
      enumerable: true,
      get() {
        reads += 1;
        return {};
      },
    });

    expect(() => createBranchSnapshotProducer(dependencies as never)).toThrow(
      "BRANCH_SNAPSHOT_PRODUCER_PORT_INVALID",
    );
    expect(reads).toBe(0);
  });

  it("requires an exact commit port without executing extra accessors", () => {
    let reads = 0;
    const port = {
      async commitSnapshot() {
        throw new Error("unreachable");
      },
    };
    Object.defineProperty(port, "secret", {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error("secret");
      },
    });

    expect(() => createBranchSnapshotProducer({ commit_port: port })).toThrow(
      "BRANCH_SNAPSHOT_PRODUCER_PORT_INVALID",
    );
    expect(reads).toBe(0);
  });

  it("maps hostile Promise rejection without reading error accessors", async () => {
    let reads = 0;
    const rejection = Object.defineProperty({}, "message", {
      enumerable: true,
      get() {
        reads += 1;
        return "BRANCH_SNAPSHOT_PRODUCER_RECEIPT_INVALID";
      },
    });
    const port: BranchSnapshotCommitPort = {
      async commitSnapshot() {
        throw rejection;
      },
    };

    await expect(createBranchSnapshotProducer({ commit_port: port }).publish(input())).rejects.toThrow(
      "BRANCH_SNAPSHOT_PRODUCER_PORT_INVALID",
    );
    expect(reads).toBe(0);
  });

  it("rejects cyclic and cumulatively oversized object graphs at the snapshot boundary", async () => {
    const port: BranchSnapshotCommitPort = {
      async commitSnapshot() {
        throw new Error("unreachable");
      },
    };
    const cyclic: Record<string, unknown> = { ...input() };
    cyclic.cycle = cyclic;

    await expect(createBranchSnapshotProducer({ commit_port: port }).publish(cyclic as never)).rejects.toThrow(
      "BRANCH_SNAPSHOT_PRODUCER_INPUT_INVALID",
    );

    let graph: unknown = { leaf: "x" };
    for (let depth = 0; depth < 21; depth += 1) graph = { left: graph, right: graph };
    await expect(createBranchSnapshotProducer({ commit_port: port }).publish(graph as never)).rejects.toThrow(
      "BRANCH_SNAPSHOT_PRODUCER_INPUT_INVALID",
    );
  });

  it("fails closed when a replayed durable record drifts from the requested identity", async () => {
    const port: BranchSnapshotCommitPort = {
      async commitSnapshot(value) {
        return {
          outcome: "replay",
          record: {
            ...value.seed,
            artifact_id: "art_foreign",
            files: value.seed.files.map((entry) => ({
              path: entry.path,
              content_kind: entry.content_kind,
              size: entry.size,
              content_hash: entry.content_hash,
              media_type: entry.media_type,
              ...(entry.action === undefined ? {} : { action: entry.action }),
            })),
          },
        };
      },
    };

    await expect(createBranchSnapshotProducer({ commit_port: port }).publish(input())).rejects.toThrow(
      "BRANCH_SNAPSHOT_PRODUCER_RECEIPT_INVALID",
    );
  });
});
