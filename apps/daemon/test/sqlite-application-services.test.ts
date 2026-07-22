import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { createSqliteApplicationServices } from "../src/services/sqlite-application-services.js";

describe("createSqliteApplicationServices", () => {
  it("composes durable services without direct conclusion-event bypasses", async () => {
    const database = new DatabaseSync(":memory:");
    const services = createSqliteApplicationServices({
      database,
      repositories: {} as never,
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
});
