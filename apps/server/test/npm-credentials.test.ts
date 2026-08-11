import { describe, expect, it } from "vitest";

import {
  createNpmPublishingCredentials,
  MemoryNpmCredentialPersistence
} from "../src/npm/credentials.js";

describe("npm publishing credentials module", () => {
  it("decodes exactly 32 bytes from the deployment key secret", async () => {
    const module = await import("../src/npm/credentials.js") as Record<string, unknown>;
    expect(module).toHaveProperty("decodeNpmCredentialEncryptionKey");
    const decode = module.decodeNpmCredentialEncryptionKey as (value: string) => Uint8Array;
    expect(Buffer.from(decode(Buffer.alloc(32, 19).toString("base64")))).toEqual(Buffer.alloc(32, 19));
    expect(() => decode("not-a-32-byte-key")).toThrow(/32 bytes/i);
  });

  it("persists a versioned encrypted envelope and resolves plaintext only for publishing", async () => {
    const persistence = new MemoryNpmCredentialPersistence();
    const credentials = createNpmPublishingCredentials({
      deploymentConfig: { scope: "@hunter-harness", token: null },
      persistence,
      encryptionKey: Buffer.alloc(32, 11),
      keyId: "publisher-key-2026",
      verifier: { verify: async () => ({ username: "hunterzheng" }) },
      now: () => new Date("2026-08-11T00:00:00.000Z")
    });

    await credentials.replace({
      token: "npm_plaintext_must_not_persist",
      expiresAt: "2026-11-09T00:00:00.000Z",
      actorId: "actor_owner"
    });

    const stored = await persistence.load();
    expect(stored).toMatchObject({
      schemaVersion: 1,
      keyId: "publisher-key-2026",
      scope: "@hunter-harness",
      username: "hunterzheng"
    });
    expect(JSON.stringify(stored)).not.toContain("npm_plaintext_must_not_persist");
    await expect(credentials.resolveForPublish()).resolves.toEqual({
      scope: "@hunter-harness",
      token: "npm_plaintext_must_not_persist"
    });
  });
});
