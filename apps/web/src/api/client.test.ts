import { describe, expect, it } from "vitest";

import { AuthenticatedHunterTransportSchema, HunterApi } from "./client.js";

describe("HunterApi", () => {
  it("parses unknown responses instead of trusting transport generics", async () => {
    const api = new HunterApi({ request: async () => ({ projects: [{ projectId: "forged", name: "Bad" }] }) });
    await expect(api.listProjects()).rejects.toThrow();
  });

  it("fails closed unless a trusted host injects the authenticated transport boundary", () => {
    expect(AuthenticatedHunterTransportSchema.safeParse(undefined).success).toBe(false);
    expect(AuthenticatedHunterTransportSchema.safeParse({ request: "fetch" }).success).toBe(false);
    expect(AuthenticatedHunterTransportSchema.safeParse({ request: async () => ({}) }).success).toBe(true);
  });
});
