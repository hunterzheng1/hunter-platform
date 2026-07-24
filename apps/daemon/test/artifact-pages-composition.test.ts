import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ArtifactIdSchema,
  AttemptIdSchema,
  ProjectIdSchema,
} from "@hunter/domain";
import { describe, expect, it } from "vitest";

import { startDaemon } from "../src/main.js";

describe("Artifact page production composition", () => {
  it("serves a durable bounded page through the authenticated loopback daemon", async () => {
    const dataDirectory = mkdtempSync(
      join(tmpdir(), "hunter artifact composition "),
    );
    const projectId = ProjectIdSchema.parse("prj_artifactcomposition01");
    const artifactId = ArtifactIdSchema.parse(
      "art_artifactcomposition01",
    );
    let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
    try {
      daemon = await startDaemon({
        dataDirectory,
        secretRef: "os-credential://hunter/install",
        secretStore: {
          resolveSecret: async () => "artifact-composition-secret",
        },
        externalHandler: {
          execute: async () => {
            throw new Error("not dispatched");
          },
        },
        verifier: {
          verify: async () => ({ status: "passed", evidence: [] }),
        },
        allowedOrigin: "app://hunter",
        publishPort: async () => undefined,
      });
      const catalog = daemon.services.artifactCatalog;
      if (catalog === undefined) {
        throw new Error("ARTIFACT_CATALOG_NOT_COMPOSED");
      }
      catalog.register({
        artifactId,
        projectId,
        attemptId: AttemptIdSchema.parse(
          "att_artifactcomposition01",
        ),
        kind: "log",
        retentionClass: "standard",
        summary: "production composition fixture",
      });
      catalog.append({
        artifactId,
        stream: "stdout",
        content: "bounded production log",
      });

      const csrf = "artifact-composition-csrf";
      const credential = daemon.services.authenticator.issueSession({
        principalId: "desktop-owner",
        authorizedProjectIds: [projectId],
        expiresAt: new Date(Date.now() + 60_000),
        csrf,
      });
      const host = `127.0.0.1:${daemon.port}`;
      const response = await fetch(
        `http://${host}/api/v1/artifacts/${artifactId}/pages?cursor=0&limit=1`,
        {
          headers: {
            host,
            origin: "app://hunter",
            authorization: `Bearer ${credential}`,
            "x-csrf-token": csrf,
          },
        },
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        schemaVersion: 1,
        status: "ok",
        artifact: {
          artifactId,
          projectId,
          summary: "production composition fixture",
        },
        entries: [{ content: "bounded production log" }],
      });
    } finally {
      if (daemon !== undefined) await daemon.shutdown();
      rmSync(dataDirectory, { recursive: true, force: true });
    }
  }, 20_000);
});
