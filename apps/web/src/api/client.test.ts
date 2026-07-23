import { describe, expect, it } from "vitest";
import {
  CreateProjectHttpRequestSchema,
  CreateRequirementHttpRequestSchema,
  ApproveRequirementHttpRequestSchema,
} from "@hunter/api-contracts";
import { ProjectIdSchema, RequirementRevisionIdSchema } from "@hunter/domain/ids";

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

  it("reuses a failed create command envelope and does not reuse it for changed input", async () => {
    const bodies: string[] = [];
    const api = new HunterApi(
      {
        request: async (_path, init) => {
          if (typeof init?.body !== "string") throw new Error("REQUEST_BODY_MISSING");
          bodies.push(init.body);
          throw new Error("response lost");
        },
      },
      {
        projectId: () => "prj_retry000001",
        requirementId: () => `req_retry00000${bodies.length + 1}`,
        requirementRevisionId: () => `rrv_retry00000${bodies.length + 1}`,
        idempotencyKey: (action) => `${action}-retry-${bodies.length + 1}`,
      },
    );
    const projectId = ProjectIdSchema.parse("prj_retry000001");
    const input = { title: "Retry", body: "same payload", acceptanceCriteria: ["same result"], constraints: [] };

    await expect(api.createRequirement(projectId, input)).rejects.toThrow("response lost");
    await expect(api.createRequirement(projectId, input)).rejects.toThrow("response lost");
    await expect(api.createRequirement(projectId, { ...input, title: "Changed" })).rejects.toThrow("response lost");

    expect(bodies[1]).toBe(bodies[0]);
    expect(bodies[2]).not.toBe(bodies[0]);
    expect(CreateRequirementHttpRequestSchema.parse(JSON.parse(bodies[0]!))).toMatchObject({ expectedVersion: 0 });
  });

  it("reuses project and approval envelopes while approval carries the authoritative version", async () => {
    const bodies: string[] = [];
    const api = new HunterApi(
      {
        request: async (_path, init) => {
          if (typeof init?.body !== "string") throw new Error("REQUEST_BODY_MISSING");
          bodies.push(init.body);
          throw new Error("response lost");
        },
      },
      {
        projectId: () => "prj_retry000002",
        requirementId: () => "req_retry000002",
        requirementRevisionId: () => "rrv_retry000002",
        idempotencyKey: (action) => `${action}-retry-${bodies.length + 1}`,
      },
    );
    const projectId = ProjectIdSchema.parse("prj_retry000001");
    const revisionId = RequirementRevisionIdSchema.parse("rrv_retry000001");

    await expect(api.createProject("Retry project")).rejects.toThrow("response lost");
    await expect(api.createProject("Retry project")).rejects.toThrow("response lost");
    await expect(Reflect.apply(api.approveRequirement, api, [projectId, revisionId, 7])).rejects.toThrow("response lost");
    await expect(Reflect.apply(api.approveRequirement, api, [projectId, revisionId, 7])).rejects.toThrow("response lost");

    expect(bodies[1]).toBe(bodies[0]);
    expect(CreateProjectHttpRequestSchema.parse(JSON.parse(bodies[0]!))).toMatchObject({ expectedVersion: 0 });
    expect(bodies[3]).toBe(bodies[2]);
    expect(ApproveRequirementHttpRequestSchema.parse(JSON.parse(bodies[2]!))).toEqual(expect.objectContaining({ expectedVersion: 7 }));
  });

  it("fails closed at pending capacity without evicting or regenerating an unconfirmed command", async () => {
    const bodies: string[] = [];
    let generatedProjectIds = 0;
    const api = new HunterApi(
      {
        request: async (_path, init) => {
          if (typeof init?.body !== "string") throw new Error("REQUEST_BODY_MISSING");
          bodies.push(init.body);
          throw new Error("response lost");
        },
      },
      {
        projectId: () => `prj_capacity${String(++generatedProjectIds).padStart(6, "0")}`,
        requirementId: () => "req_capacity000001",
        requirementRevisionId: () => "rrv_capacity000001",
        idempotencyKey: (action) => `${action}-capacity-${generatedProjectIds}`,
      },
    );

    for (let index = 1; index <= 32; index += 1) {
      await expect(api.createProject(`Pending ${index}`)).rejects.toThrow("response lost");
    }
    const firstBody = bodies[0];

    let capacityError: unknown;
    try {
      await api.createProject("Pending 33");
    } catch (error) {
      capacityError = error;
    }
    await expect(api.createProject("Pending 1")).rejects.toThrow("response lost");

    expect(capacityError).toEqual(new Error("PENDING_COMMAND_LIMIT_REACHED"));
    expect(generatedProjectIds).toBe(32);
    expect(bodies).toHaveLength(33);
    expect(bodies[32]).toBe(firstBody);
  });
});
