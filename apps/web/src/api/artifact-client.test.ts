import { describe, expect, it, vi } from "vitest";

import { HunterApi } from "./client.js";

const artifactId = "art_webartifact01";

function response() {
  return {
    schemaVersion: 1,
    status: "ok",
    artifact: {
      artifactId,
      projectId: "prj_webartifact01",
      attemptId: "att_webartifact01",
      kind: "log",
      retentionClass: "standard",
      summary: "web artifact fixture",
      byteLength: 5,
      entryCount: 1,
    },
    cursor: 0,
    nextCursor: 1,
    retentionFloor: 0,
    highWaterCursor: 1,
    complete: true,
    responseBytes: 5,
    entries: [{
      cursor: 1,
      stream: "stdout",
      content: "hello",
      contentHash: "a".repeat(64),
      byteLength: 5,
      occurredAt: "2026-07-24T12:00:00.000Z",
    }],
  };
}

describe("HunterApi Artifact pages", () => {
  it("requests one bounded cursor page and validates the Artifact scope", async () => {
    const request = vi.fn(async () => response());
    const api = new HunterApi({ request });

    await expect(api.getArtifactPage(artifactId, {
      cursor: 0,
      limit: 1,
    })).resolves.toEqual(response());
    expect(request).toHaveBeenCalledWith(
      `/api/v1/artifacts/${artifactId}/pages?cursor=0&limit=1`,
    );
  });

  it("rejects malformed or cross-Artifact responses", async () => {
    const api = new HunterApi({
      request: vi.fn(async () => ({
        ...response(),
        artifact: {
          ...response().artifact,
          artifactId: "art_webartifact02",
        },
      })),
    });
    await expect(api.getArtifactPage(artifactId, {
      cursor: 0,
      limit: 1,
    })).rejects.toThrow("ARTIFACT_RESPONSE_SCOPE_MISMATCH");
  });
});
