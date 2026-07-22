import type { FastifyInstance } from "fastify";

export function registerProjectRoutes(app: FastifyInstance): void {
  app.get("/projects", async () => ({ projects: [] }));
}
