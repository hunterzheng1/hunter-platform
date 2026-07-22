import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createSqliteApplicationServices } from "../src/services/sqlite-application-services.js";
import { startDaemon } from "../src/main.js";

describe("createSqliteApplicationServices", () => {
  it("composes durable services without direct conclusion-event bypasses", async () => {
    const database = new DatabaseSync(":memory:");
    const services = createSqliteApplicationServices({
      database,
      externalHandler: { execute: async () => { throw new Error("not dispatched"); } },
      installSecret: "composition-secret-for-tests",
      allowedHosts: ["hunter-test.localhost"],
      allowedOrigins: ["app://hunter"],
    });
    expect(services).toMatchObject({ journal: expect.anything(), flowEngine: expect.anything(), operationWorker: expect.anything(), recovery: expect.anything(), eventReader: expect.anything() });
    const source = await readFile(new URL("../src/services/sqlite-application-services.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/StepSucceeded|RunSucceeded/u);
    database.close();
  });

  it("resolves an OS-owned SecretRef before listen and persists only the reference", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "hunter-secret-ref-"));
    const resolved: string[] = [];
    const daemon = await startDaemon({
      dataDirectory,
      secretRef: "os-credential://hunter/install",
      secretStore: { resolveSecret: async (secretRef) => { resolved.push(secretRef); return "resolved-install-secret-tests"; } },
      externalHandler: { execute: async () => { throw new Error("not dispatched"); } },
      allowedHost: "hunter-test.localhost",
      allowedOrigin: "app://hunter",
      publishPort: async () => undefined,
    });
    expect(resolved).toEqual(["os-credential://hunter/install"]);
    expect(daemon.port).toBeGreaterThan(0);
    const inspection = new DatabaseSync(join(dataDirectory, "hunter.sqlite"));
    expect(inspection.prepare("SELECT metadata_value FROM storage_metadata WHERE metadata_key = 'local_secret_ref'").get()).toEqual({ metadata_value: "os-credential://hunter/install" });
    expect(JSON.stringify(inspection.prepare("SELECT metadata_value FROM storage_metadata").all())).not.toContain("resolved-install-secret-tests");
    inspection.close();
    await daemon.shutdown();
    await daemon.shutdown();
  });
});
