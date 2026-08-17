import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";

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
import { writeAudit } from "../audit/audit.js";

export interface AuthRoutesOptions {
  repository: ServerRepository;
  /**
   * 项目 API key 明文的 AES-256-GCM 包裹密钥（与 npm 凭证同一 env 派生）。
   * null = 功能关闭：新建 key 不再存密文，reveal 一律 409。
   */
  projectKeyEncryptionKey?: Uint8Array | null;
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
    last_used_at: key.lastUsedAt,
    revealable: key.keyCiphertext !== null
  };
}

const PROJECT_KEY_CIPHER = "aes-256-gcm";

function encryptProjectKey(plaintext: string, key: Uint8Array): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(PROJECT_KEY_CIPHER, Buffer.from(key), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"),
    ciphertext.toString("base64")].join(".");
}

function decryptProjectKey(packed: string, key: Uint8Array): string {
  const parts = packed.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new ServerDomainError(500, "KEY_CIPHERTEXT_INVALID", "stored key ciphertext is malformed");
  }
  const [, iv, authTag, ciphertext] = parts as [string, string, string, string];
  const decipher = createDecipheriv(PROJECT_KEY_CIPHER, Buffer.from(key), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(authTag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
}

function publicUser(user: UserRecord, ownerActorId: string): Record<string, unknown> {
  return {
    user_id: user.userId,
    username: user.username,
    display_name: user.displayName,
    actor_id: user.actorId,
    system_role: user.actorId === ownerActorId ? "owner" : "member",
    created_at: user.createdAt
  };
}

export async function requireSessionUser(
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
    return reply.code(201).send({ user: publicUser(user, ownerActorId) });
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
      user: publicUser(user, ownerActorId)
    });
  });

  app.get("/api/v1/auth/me", async (request) => {
    const { user } = await requireSessionUser(request, repository);
    return { user: publicUser(user, ownerActorId) };
  });

  app.post("/api/v1/auth/logout", async (request) => {
    const { token } = await requireSessionUser(request, repository);
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
    const { user } = await requireSessionUser(request, repository);
    const { projectId } = request.params as { projectId: string };
    // Ownership check: throws 404 when the project is not visible to this actor.
    await repository.getProject(user.actorId, projectId);
    const body = createKeySchema.parse(request.body);
    const plaintext = generateProjectApiKey();
    const wrapKey = options.projectKeyEncryptionKey ?? null;
    const record = await repository.createProjectApiKey({
      keyId: "key_" + randomUUID().replaceAll("-", ""),
      keyHash: projectApiKeyHash(plaintext),
      projectId,
      actorId: user.actorId,
      label: body.label,
      scopes: body.scopes as ProjectKeyScope[],
      keyCiphertext: wrapKey === null ? null : encryptProjectKey(plaintext, wrapKey)
    });
    // 哈希用于认证；密文（配置了包裹密钥时）支持已登录用户再次查看
    return reply.code(201).send({
      ...publicProjectKey(record),
      api_key: plaintext
    });
  });

  app.get("/api/v1/projects/:projectId/api-keys", async (request) => {
    const { user } = await requireSessionUser(request, repository);
    const { projectId } = request.params as { projectId: string };
    await repository.getProject(user.actorId, projectId);
    const keys = await repository.listProjectApiKeys(projectId);
    return { items: keys.map((key) => publicProjectKey(key)) };
  });

  // 再次查看明文：仅登录会话可用（泄漏的项目 key 不能自我揭示），并写审计
  app.post("/api/v1/projects/:projectId/api-keys/:keyId/reveal", async (request) => {
    const { user } = await requireSessionUser(request, repository);
    const { projectId, keyId } = request.params as { projectId: string; keyId: string };
    await repository.getProject(user.actorId, projectId);
    const keys = await repository.listProjectApiKeys(projectId);
    const key = keys.find((item) => item.keyId === keyId && item.revokedAt === null);
    if (key === undefined) {
      throw new ServerDomainError(404, "KEY_NOT_FOUND", "API key not found or already revoked");
    }
    const wrapKey = options.projectKeyEncryptionKey ?? null;
    if (key.keyCiphertext === null || wrapKey === null) {
      throw new ServerDomainError(409, "KEY_NOT_REVEALABLE",
        "该密钥创建时未启用可恢复存储，无法再次查看；请吊销后新建");
    }
    await writeAudit(repository, {
      actorId: user.actorId,
      projectId,
      action: "project_api_key.revealed",
      targetId: keyId,
      requestId: request.id,
      details: { label: key.label }
    });
    return { key_id: keyId, api_key: decryptProjectKey(key.keyCiphertext, wrapKey) };
  });

  app.delete("/api/v1/projects/:projectId/api-keys/:keyId", async (request) => {
    const { user } = await requireSessionUser(request, repository);
    const { projectId, keyId } = request.params as { projectId: string; keyId: string };
    await repository.getProject(user.actorId, projectId);
    const revoked = await repository.revokeProjectApiKey(projectId, keyId);
    if (!revoked) {
      throw new ServerDomainError(404, "KEY_NOT_FOUND", "API key not found or already revoked");
    }
    return { ok: true };
  });

  app.post("/api/v1/auth/invites", async (request, reply) => {
    const { user } = await requireSessionUser(request, repository);
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
