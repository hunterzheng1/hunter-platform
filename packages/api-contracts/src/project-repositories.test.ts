import { describe, expect, it } from "vitest";

import { ProjectDetailHttpResponseSchema } from "./http.js";

describe("Project repository HTTP contract", () => {
  it("publishes repository identities without device-local paths", () => {
    const detail = {
      projectId: "prj_repositoryappend",
      name: "Repository append",
      requirements: [],
      repositoryBindingVersion: 1,
      repositoryBindings: [
        { repositoryId: "rep_repositoryprimary", role: "primary" },
        { repositoryId: "rep_repositorysecondary", role: "secondary" },
      ],
    };

    expect(ProjectDetailHttpResponseSchema.parse(detail)).toEqual(detail);
    expect(() =>
      ProjectDetailHttpResponseSchema.parse({
        ...detail,
        repositoryBindings: [
          ...detail.repositoryBindings,
          {
            repositoryId: "rep_repositorythird",
            role: "secondary",
            localPath: "C:\\private",
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      ProjectDetailHttpResponseSchema.parse({
        ...detail,
        repositoryBindings: [
          detail.repositoryBindings[0],
          detail.repositoryBindings[0],
        ],
      }),
    ).toThrow();
  });

  it("requires a strict idempotent append command and a secondary-only receipt", async () => {
    const contracts = await import("./index.js") as Record<string, unknown>;
    expect(contracts.AppendProjectRepositoryHttpRequestSchema)
      .toEqual(expect.any(Object));
    expect(contracts.AppendProjectRepositoryHttpResponseSchema)
      .toEqual(expect.any(Object));
    const requestSchema = contracts.AppendProjectRepositoryHttpRequestSchema as {
      parse(input: unknown): unknown;
    };
    const responseSchema = contracts.AppendProjectRepositoryHttpResponseSchema as {
      parse(input: unknown): unknown;
    };
    const request = {
      repositoryId: "rep_repositorysecondary",
      expectedVersion: 0,
      idempotencyKey: "append-repository-secondary-1",
    };
    const response = {
      projectId: "prj_repositoryappend",
      repositoryBindingVersion: 1,
      repositoryBinding: {
        repositoryId: "rep_repositorysecondary",
        role: "secondary",
      },
    };

    expect(requestSchema.parse(request)).toEqual(request);
    expect(responseSchema.parse(response)).toEqual(response);
    expect(() =>
      requestSchema.parse({ ...request, localPath: "C:\\private" }),
    ).toThrow();
    expect(() =>
      responseSchema.parse({
        ...response,
        repositoryBinding: {
          ...response.repositoryBinding,
          role: "primary",
        },
      }),
    ).toThrow();
  });
});
