import type { FastifyInstance } from "fastify";
import type { ProjectId } from "@hunter/domain";
import { requirePrincipal } from "../http/security-hooks.js";

export interface ProjectRoutesServices {
  listProjects(authorizedProjectIds: readonly ProjectId[]): Promise<readonly unknown[]>;
}

export function registerProjectRoutes(app: FastifyInstance, services: ProjectRoutesServices): void {
  app.get("/projects", async (request) => {
    const principal = requirePrincipal(request);
    return { projects: await services.listProjects(principal.authorizedProjectIds) };
  });
}
