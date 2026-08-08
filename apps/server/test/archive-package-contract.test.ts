import { uuidV7 } from "@hunter-harness/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer } from "../src/app.js";
import { MemoryRepository } from "../src/repositories/memory.js";
import { MemoryArtifactStorage } from "../src/storage/memory.js";

describe("archive package HTTP contract", () => {
  const token = "archive-contract-token";
  let app: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    const repository = new MemoryRepository();
    await repository.createActorWithToken({ actorId: "actor_archive_contract", token });
    app = await createServer({
      repository,
      storage: new MemoryArtifactStorage(),
      config: { maxProposalBytes: 64 }
    });
  });

  afterEach(async () => {
    await app.close();
  });

  function headers(contentType: string): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      "content-type": contentType,
      "x-request-id": uuidV7(),
      "idempotency-key": uuidV7()
    };
  }

  it("rejects archive uploads that do not declare application/zip", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/projects/prj_missing/changes/chg-media/archive-package",
      headers: headers("application/octet-stream"),
      payload: Buffer.from("not a zip")
    });

    expect(response.statusCode).toBe(415);
    expect(response.json()).toMatchObject({
      error: { code: "ARCHIVE_MEDIA_TYPE_UNSUPPORTED" }
    });
  });

  it("uses an archive-specific error when the request body exceeds the limit", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/projects/prj_missing/changes/chg-large/archive-package",
      headers: headers("application/zip"),
      payload: Buffer.alloc(65, 1)
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({
      error: { code: "ARCHIVE_PACKAGE_TOO_LARGE" }
    });
  });
});
