import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type {
  ProjectApiKeyRecord,
  ProjectKeyScope,
  ServerRepository,
  UserRecord
} from "../repositories/interfaces.js";
import { PROJECT_KEY_SCOPES, ServerDomainError } from "../repositories/interfaces.js";
import {
  generateInviteCode,
  generateProjectApiKey,
  generateSessionToken,
  hashPassword,
  inviteCodeHash,
  projectApiKeyHash,
  SESSION_TOKEN_PREFIX,
  sessionTokenHash,
  verifyPassword
} from "./accounts.js";
import { authenticateRequest, bearerToken, requestProjectKey } from "./tokens.js";

export interface AuthRoutesOptions {
  repository: ServerRepository;
  /** Session lifetime; default 30 days. */
  sessionTtlMs?: number;
  /** Invite code lifetime; default 7 days. */
  inviteTtlMs?: number;
  /** Actor bound to the first registered user (keeps bootstrap-owned data visible). */
  ownerActorId?: string;
}

const registerSchema = z.object({
  username: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,31}$/),
  password: z.string().min(8).max(128),
  display_name: z.string().min(1).max(100).optional(),
  invite_code: z.string().min(1).optional()
}).strict();

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1)
}).strict();

const createKeySchema = z.object({
  label: z.string().min(1).max(100),
  scopes: z.array(z.enum(PROJECT_KEY_SCOPES)).min(1)
}).strict();

function publicProjectKey(key: ProjectApiKeyRecord): Record<string, unknown> {
  return {
    key_id: key.keyId,
    project_id: key.projectId,
    label: key.label,
    scopes: key.scopes,
    created_at: key.createdAt,
    revoked_at: key.revokedAt,
    last_used_at: key.lastUsedAt
  };
}

function publicUser(user: UserRecord): Record<string, unknown> {
  return {
    user_id: user.userId,
    username: user.username,
    display_name: user.displayName,
    actor_id: user.actorId,
    created_at: user.createdAt
  };
}

async function sessionUser(
  request: FastifyRequest,
  repository: ServerRepository
): Promise<{ token: string; user: UserRecord }> {
  const token = bearerToken(request);
  if (!token.startsWith(SESSION_TOKEN_PREFIX)) {
    throw new ServerDomainError(403, "SESSION_REQUIRED", "a login session token is required");
  }
  const user = await repository.authenticateSessionHash(
    sessionTokenHash(token),
    new Date().toISOString()
  );
  if (user === null) {
    throw new ServerDomainError(401, "SESSION_INVALID", "session token is invalid or expired");
  }
  return { token, user };
}

export function registerAuthRoutes(app: FastifyInstance, options: AuthRoutesOptions): void {
  const { repository } = options;
  const sessionTtlMs = options.sessionTtlMs ?? 30 * 24 * 60 * 60 * 1000;
  const inviteTtlMs = options.inviteTtlMs ?? 7 * 24 * 60 * 60 * 1000;
  const ownerActorId = options.ownerActorId ?? "actor_owner";

  // Public: lets the web console decide between first-run register and login.
  app.get("/api/v1/auth/status", async () => ({
    users_exist: (await repository.countUsers()) > 0
  }));

  app.post("/api/v1/auth/register", async (request, reply) => {
    const body = registerSchema.parse(request.body);
    const now = new Date().toISOString();
    const isFirstUser = (await repository.countUsers()) === 0;
    if (await repository.getUserByUsername(body.username) !== null) {
      throw new ServerDomainError(409, "USERNAME_TAKEN", "username already exists");
    }
    const userId = "usr_" + randomUUID().replaceAll("-", "");
    if (!isFirstUser) {
      if (body.invite_code === undefined) {
        throw new ServerDomainError(403, "INVITE_REQUIRED", "registration requires an invite code");
      }
      const consumed = await repository.consumeInviteCode(
        inviteCodeHash(body.invite_code),
        userId,
        now
      );
      if (!consumed) {
        throw new ServerDomainError(403, "INVITE_INVALID", "invite code is invalid, used, or expired");
      }
    }
    const user = await repository.createUser({
      userId,
      username: body.username,
      displayName: body.display_name ?? body.username,
      passwordHash: await hashPassword(body.password),
      // First user inherits the bootstrap actor so pre-login data stays visible.
      actorId: isFirstUser ? ownerActorId : "actor_" + randomUUID().replaceAll("-", "")
    });
    return reply.code(201).send({ user: publicUser(user) });
  });

  app.post("/api/v1/auth/login", async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const user = await repository.getUserByUsername(body.username);
    const passwordOk = user !== null &&
      user.disabledAt === null &&
      await verifyPassword(body.password, user.passwordHash);
    if (user === null || !passwordOk) {
      throw new ServerDomainError(401, "INVALID_CREDENTIALS", "username or password is incorrect");
    }
    const token = generateSessionToken();
    const expiresAt = new Date(Date.now() + sessionTtlMs).toISOString();
    await repository.createUserSession({
      tokenHash: sessionTokenHash(token),
      userId: user.userId,
      expiresAt
    });
    return reply.code(200).send({
      token,
      expires_at: expiresAt,
      user: publicUser(user)
    });
  });

  app.get("/api/v1/auth/me", async (request) => {
    const { user } = await sessionUser(request, repository);
    return { user: publicUser(user) };
  });

  app.post("/api/v1/auth/logout", async (request) => {
    const { token } = await sessionUser(request, repository);
    await repository.revokeUserSession(sessionTokenHash(token));
    return { ok: true };
  });

  // Verification endpoint for `hunter-harness connect`: describes the presented credential.
  app.get("/api/v1/auth/key-info", async (request) => {
    const actor = await authenticateRequest(request, repository);
    const key = requestProjectKey(request);
    if (key !== undefined) {
      const project = await repository.getProject(actor.actorId, key.projectId);
      return {
        kind: "project-key",
        actor_id: actor.actorId,
        project_id: key.projectId,
        project_display_name: project.displayName,
        scopes: key.scopes,
        label: key.label
      };
    }
    const token = bearerToken(request);
    return {
      kind: token.startsWith(SESSION_TOKEN_PREFIX) ? "session" : "api-token",
      actor_id: actor.actorId
    };
  });

  // Project API key management is restricted to logged-in humans.
  app.post("/api/v1/projects/:projectId/api-keys", async (request, reply) => {
    const { user } = await sessionUser(request, repository);
    const { projectId } = request.params as { projectId: string };
    // Ownership check: throws 404 when the project is not visible to this actor.
    await repository.getProject(user.actorId, projectId);
    const body = createKeySchema.parse(request.body);
    const plaintext = generateProjectApiKey();
    const record = await repository.createProjectApiKey({
      keyId: "key_" + randomUUID().replaceAll("-", ""),
      keyHash: projectApiKeyHash(plaintext),
      projectId,
      actorId: user.actorId,
      label: body.label,
      scopes: body.scopes as ProjectKeyScope[]
    });
    // Plaintext is returned exactly once; only the hash is stored.
    return reply.code(201).send({
      ...publicProjectKey(record),
      api_key: plaintext
    });
  });

  app.get("/api/v1/projects/:projectId/api-keys", async (request) => {
    const { user } = await sessionUser(request, repository);
    const { projectId } = request.params as { projectId: string };
    await repository.getProject(user.actorId, projectId);
    const keys = await repository.listProjectApiKeys(projectId);
    return { items: keys.map((key) => publicProjectKey(key)) };
  });

  app.delete("/api/v1/projects/:projectId/api-keys/:keyId", async (request) => {
    const { user } = await sessionUser(request, repository);
    const { projectId, keyId } = request.params as { projectId: string; keyId: string };
    await repository.getProject(user.actorId, projectId);
    const revoked = await repository.revokeProjectApiKey(projectId, keyId);
    if (!revoked) {
      throw new ServerDomainError(404, "KEY_NOT_FOUND", "API key not found or already revoked");
    }
    return { ok: true };
  });

  app.post("/api/v1/auth/invites", async (request, reply) => {
    const { user } = await sessionUser(request, repository);
    const code = generateInviteCode();
    const expiresAt = new Date(Date.now() + inviteTtlMs).toISOString();
    await repository.createInviteCode({
      codeHash: inviteCodeHash(code),
      createdBy: user.userId,
      expiresAt
    });
    // Plaintext code is only returned once; the server stores its hash.
    return reply.code(201).send({ invite_code: code, expires_at: expiresAt });
  });
}
