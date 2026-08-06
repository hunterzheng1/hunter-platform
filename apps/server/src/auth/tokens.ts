import type { FastifyRequest } from "fastify";

import type {
  Actor,
  ProjectApiKeyRecord,
  ProjectKeyScope,
  ServerRepository
} from "../repositories/interfaces.js";
import { ServerDomainError } from "../repositories/interfaces.js";
import {
  projectApiKeyHash,
  SESSION_TOKEN_PREFIX,
  sessionTokenHash
} from "./accounts.js";

export function bearerToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  if (authorization === undefined || !authorization.startsWith("Bearer ")) {
    throw new ServerDomainError(401, "AUTH_REQUIRED", "Bearer authentication is required");
  }
  return authorization.slice("Bearer ".length);
}

interface ProjectKeyAwareRequest extends FastifyRequest {
  projectApiKey?: ProjectApiKeyRecord;
}

/** Returns the project-key record when the request authenticated via a project API key. */
export function requestProjectKey(request: FastifyRequest): ProjectApiKeyRecord | undefined {
  return (request as ProjectKeyAwareRequest).projectApiKey;
}

/**
 * Enforce project-key scoping on a route. No-op for session/api-token auth.
 * When the route addresses a specific project, a mismatching key is rejected.
 */
export function assertProjectKeyScope(
  request: FastifyRequest,
  scope: ProjectKeyScope,
  projectId?: string
): void {
  const key = requestProjectKey(request);
  if (key === undefined) return;
  if (!key.scopes.includes(scope)) {
    throw new ServerDomainError(403, "PROJECT_KEY_SCOPE", "API key lacks required scope", {
      required_scope: scope
    });
  }
  if (projectId !== undefined && projectId !== key.projectId) {
    throw new ServerDomainError(403, "PROJECT_KEY_MISMATCH", "API key is bound to another project");
  }
}

export async function authenticateRequest(
  request: FastifyRequest,
  repository: ServerRepository
): Promise<Actor> {
  const token = bearerToken(request);
  if (token.startsWith(SESSION_TOKEN_PREFIX)) {
    const user = await repository.authenticateSessionHash(
      sessionTokenHash(token),
      new Date().toISOString()
    );
    if (user === null) {
      throw new ServerDomainError(401, "SESSION_INVALID", "session token is invalid or expired");
    }
    return { actorId: user.actorId };
  }
  const actor = await repository.authenticateToken(token);
  if (actor !== null) return actor;
  const projectKey = await repository.authenticateProjectKeyHash(
    projectApiKeyHash(token),
    new Date().toISOString()
  );
  if (projectKey !== null) {
    (request as ProjectKeyAwareRequest).projectApiKey = projectKey;
    return { actorId: projectKey.actorId };
  }
  throw new ServerDomainError(401, "TOKEN_INVALID", "API token is invalid");
}
