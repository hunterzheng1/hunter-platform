import {
  ArtifactPageHttpResponseSchema,
  type ArtifactPageHttpQuery,
  type ArtifactPageHttpResponse,
} from "@hunter/api-contracts";
import type { ArtifactId, ProjectId } from "@hunter/domain";
import type { SqliteArtifactCatalog } from "@hunter/storage";

import type { ArtifactRoutesServices } from "../routes/artifacts.js";

export class SqliteArtifactPages implements ArtifactRoutesServices {
  public constructor(private readonly catalog: SqliteArtifactCatalog) {}

  public projectForArtifact(artifactId: ArtifactId): {
    readonly projectId: ProjectId;
    readonly artifactId: ArtifactId;
  } | null {
    const artifact = this.catalog.find(artifactId);
    return artifact === null
      ? null
      : {
          projectId: artifact.projectId,
          artifactId: artifact.artifactId,
        };
  }

  public readPage(
    artifactId: ArtifactId,
    query: ArtifactPageHttpQuery,
  ): ArtifactPageHttpResponse | null {
    const artifact = this.catalog.find(artifactId);
    if (artifact === null) return null;
    const page = this.catalog.readPage({
      artifactId,
      cursor: query.cursor,
      limit: query.limit,
    });
    if (page.status === "resync_required") {
      return ArtifactPageHttpResponseSchema.parse({
        schemaVersion: 1,
        ...page,
      });
    }
    return ArtifactPageHttpResponseSchema.parse({
      schemaVersion: 1,
      status: "ok",
      artifact: {
        artifactId: artifact.artifactId,
        projectId: artifact.projectId,
        attemptId: artifact.attemptId,
        kind: artifact.kind,
        retentionClass: artifact.retentionClass,
        summary: artifact.summary,
        byteLength: artifact.byteLength,
        entryCount: artifact.entryCount,
      },
      cursor: page.cursor,
      nextCursor: page.nextCursor,
      retentionFloor: page.retentionFloor,
      highWaterCursor: page.highWaterCursor,
      complete: page.complete,
      responseBytes: page.responseBytes,
      entries: page.entries.map((entry) => ({
        cursor: entry.cursor,
        stream: entry.stream,
        content: entry.content,
        contentHash: entry.contentHash,
        byteLength: entry.byteLength,
        occurredAt: entry.occurredAt,
      })),
    });
  }
}
