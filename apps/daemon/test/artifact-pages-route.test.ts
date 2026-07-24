import {
  ArtifactIdSchema,
  AttemptIdSchema,
} from "@hunter/domain";
import { describe, expect, it, vi } from "vitest";

import { buildTestApp, projectA, projectB } from "./support/build-test-app.js";

const artifactId = ArtifactIdSchema.parse("art_routepages01");
const attemptId = AttemptIdSchema.parse("att_routepages01");

function page() {
  return {
    schemaVersion: 1 as const,
    status: "ok" as const,
    artifact: {
      artifactId,
      projectId: projectA,
      attemptId,
      kind: "log" as const,
      retentionClass: "standard" as const,
      summary: "bounded route fixture",
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
      stream: "stdout" as const,
      content: "hello",
      contentHash: "a".repeat(64),
      byteLength: 5,
      occurredAt: "2026-07-24T12:00:00.000Z",
    }],
  };
}

describe("Artifact page route", () => {
  it("authorizes Project scope and returns only the requested bounded page", async () => {
    const readPage = vi.fn(() => page());
    const { app, headers } = buildTestApp({
      artifacts: {
        projectForArtifact: vi.fn(() => ({ projectId: projectA, artifactId })),
        readPage,
      },
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/artifacts/${artifactId}/pages?cursor=0&limit=1`,
      headers,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(page());
    expect(readPage).toHaveBeenCalledWith(artifactId, {
      cursor: 0,
      limit: 1,
    });
    await app.close();
  });

  it("passes through an explicit retention-floor resync receipt", async () => {
    const resync = {
      schemaVersion: 1 as const,
      status: "resync_required" as const,
      artifactId,
      code: "ARTIFACT_CURSOR_RESYNC_REQUIRED" as const,
      retentionFloor: 4,
      highWaterCursor: 8,
      instructions: {
        snapshot: "reload_artifact_summary" as const,
        resume: "read_after_retention_floor" as const,
      },
    };
    const { app, headers } = buildTestApp({
      artifacts: {
        projectForArtifact: vi.fn(() => ({ projectId: projectA, artifactId })),
        readPage: vi.fn(() => resync),
      },
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/artifacts/${artifactId}/pages?cursor=1&limit=2`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(resync);
    await app.close();
  });

  it("returns a bounded conflict instead of 500 for a future cursor", async () => {
    const { app, headers } = buildTestApp({
      artifacts: {
        projectForArtifact: vi.fn(() => ({ projectId: projectA, artifactId })),
        readPage: vi.fn(() => {
          throw new Error("ARTIFACT_CURSOR_AHEAD_OF_HIGH_WATER");
        }),
      },
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/artifacts/${artifactId}/pages?cursor=999&limit=1`,
      headers,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      code: "ARTIFACT_CURSOR_AHEAD_OF_HIGH_WATER",
    });
    await app.close();
  });

  it("rejects cross-Project access and malformed queries before reading content", async () => {
    const readPage = vi.fn(() => page());
    const { app, headers } = buildTestApp({
      artifacts: {
        projectForArtifact: vi.fn(() => ({ projectId: projectB, artifactId })),
        readPage,
      },
    });

    const malformed = await app.inject({
      method: "GET",
      url: `/api/v1/artifacts/${artifactId}/pages?cursor=0&limit=999&path=private`,
      headers,
    });
    const forbidden = await app.inject({
      method: "GET",
      url: `/api/v1/artifacts/${artifactId}/pages?cursor=0&limit=1`,
      headers,
    });

    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual({ code: "REQUEST_SCHEMA_INVALID" });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toEqual({ code: "PROJECT_FORBIDDEN" });
    expect(readPage).not.toHaveBeenCalled();
    await app.close();
  });

  it("fails closed when a service response crosses Artifact or Project scope", async () => {
    const { app, headers } = buildTestApp({
      artifacts: {
        projectForArtifact: vi.fn(() => ({ projectId: projectA, artifactId })),
        readPage: vi.fn(() => ({
          ...page(),
          artifact: { ...page().artifact, projectId: projectB },
        })),
      },
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/artifacts/${artifactId}/pages?cursor=0&limit=1`,
      headers,
    });
    expect(response.statusCode).toBe(500);
    await app.close();
  });
});
