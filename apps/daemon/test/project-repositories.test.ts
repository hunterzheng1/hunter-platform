import type {
  AppendProjectRepositoryHttpRequest,
  AppendProjectRepositoryHttpResponse,
} from "@hunter/api-contracts";
import { RepositoryIdSchema } from "@hunter/domain";
import { describe, expect, it, vi } from "vitest";

import {
  buildTestApp,
  projectA,
  projectB,
} from "./support/build-test-app.js";

describe("project repository routes", () => {
  it("appends only a strict secondary repository inside the authorized project", async () => {
    const repositoryId = RepositoryIdSchema.parse("rep_task2secondary");
    const appendProjectRepository = vi.fn(
      async (
        projectId: typeof projectA,
        command: AppendProjectRepositoryHttpRequest,
      ): Promise<AppendProjectRepositoryHttpResponse> => ({
        projectId,
        repositoryBindingVersion: command.expectedVersion + 1,
        repositoryBinding: {
          repositoryId: command.repositoryId,
          role: "secondary",
        },
      }),
    );
    const { app, headers } = buildTestApp({
      appendProjectRepository,
    });
    const payload = {
      repositoryId,
      expectedVersion: 0,
      idempotencyKey: "append-project-repository-task2",
    };

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectA}/repositories`,
      headers,
      payload,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      projectId: projectA,
      repositoryBindingVersion: 1,
      repositoryBinding: {
        repositoryId,
        role: "secondary",
      },
    });
    expect(appendProjectRepository).toHaveBeenCalledWith(
      projectA,
      payload,
      expect.objectContaining({ actorId: "desktop-owner" }),
    );

    const forbidden = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectB}/repositories`,
      headers,
      payload,
    });
    const privatePath = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectA}/repositories`,
      headers,
      payload: { ...payload, localPath: "C:\\private" },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(privatePath.statusCode).toBe(400);
    expect(appendProjectRepository).toHaveBeenCalledOnce();
    await app.close();
  });
});
