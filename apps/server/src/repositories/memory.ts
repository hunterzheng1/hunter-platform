import { artifactManifestSchema, canonicalJson } from "@hunter-harness/contracts";
import { sha256Bytes } from "@hunter-harness/core";

import type {
  Actor,
  ArtifactRecord,
  AuditEvent,
  ChangeArchivePackageRecord,
  IdempotencyRecord,
  ProjectRecord,
  ProjectFileRecord,
  ProposalRecord,
  ProposalSessionRecord,
  ReviewRecord,
  KnowledgeIngestRecord,
  NpmPublishingCredentialRecord,
  ProjectApiKeyRecord,
  ProjectKeyScope,
  ServerRepository,
  TransactionRepository,
  UserRecord
} from "./interfaces.js";
import { ServerDomainError } from "./interfaces.js";
import { applyProjectFileOperations } from "./project-files.js";

function tokenHash(token: string): string {
  return sha256Bytes("hunter-harness-token\0" + token);
}

export class MemoryRepository implements ServerRepository {
  private readonly tokens = new Map<string, Actor>();
  private readonly projects = new Map<string, ProjectRecord>();
  private readonly projectFiles = new Map<string, Map<string, ProjectFileRecord>>();
  private readonly bindings = new Map<string, string>();
  private readonly sessions = new Map<string, ProposalSessionRecord>();
  private readonly proposals = new Map<string, ProposalRecord>();
  private readonly artifacts = new Map<string, ArtifactRecord>();
  private readonly archivePackages = new Map<string, ChangeArchivePackageRecord>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly users = new Map<string, UserRecord>();
  private readonly userSessions = new Map<string, {
    userId: string;
    expiresAt: string;
    revokedAt: string | null;
  }>();
  private readonly inviteCodes = new Map<string, {
    createdBy: string;
    expiresAt: string;
    usedBy: string | null;
  }>();
  /** key: keyHash */
  private readonly projectApiKeys = new Map<string, ProjectApiKeyRecord>();
  /** key: projectId + "\0" + entryId */
  private readonly knowledgeEntries = new Map<string, KnowledgeIngestRecord>();
  private readonly auditEvents: AuditEvent[] = [];
  private npmPublishingCredential: NpmPublishingCredentialRecord | null = null;
  private readonly idempotencyLocks = new Map<string, Promise<void>>();
  private transactionTail: Promise<void> = Promise.resolve();
  private counters = {
    project: 0,
    session: 0,
    proposal: 0,
    item: 0,
    review: 0,
    artifact: 0,
    version: 0,
    event: 0,
    archive: 0
  };

  async createActorWithToken(input: { actorId: string; token: string }): Promise<void> {
    this.tokens.set(tokenHash(input.token), { actorId: input.actorId });
  }

  async acquireIdempotencyLock(input: {
    actorId: string;
    method: string;
    path: string;
    key: string;
  }): Promise<{ release(): Promise<void> }> {
    const key = this.idempotencyKey(input);
    const previous = this.idempotencyLocks.get(key) ?? Promise.resolve();
    let releaseCurrent: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const tail = previous.then(async () => current);
    this.idempotencyLocks.set(key, tail);
    await previous;
    return {
      release: async () => {
        releaseCurrent?.();
        if (this.idempotencyLocks.get(key) === tail) {
          this.idempotencyLocks.delete(key);
        }
      }
    };
  }

  async authenticateToken(token: string): Promise<Actor | null> {
    return this.tokens.get(tokenHash(token)) ?? null;
  }

  async getNpmPublishingCredential(): Promise<NpmPublishingCredentialRecord | null> {
    return this.npmPublishingCredential === null ? null : structuredClone(this.npmPublishingCredential);
  }

  async saveNpmPublishingCredential(record: NpmPublishingCredentialRecord): Promise<void> {
    this.npmPublishingCredential = structuredClone(record);
  }

  async clearNpmPublishingCredential(): Promise<boolean> {
    const existed = this.npmPublishingCredential !== null;
    this.npmPublishingCredential = null;
    return existed;
  }

  async countUsers(): Promise<number> {
    return this.users.size;
  }

  async createUser(input: {
    userId: string;
    username: string;
    displayName: string;
    passwordHash: string;
    actorId: string;
  }): Promise<UserRecord> {
    for (const user of this.users.values()) {
      if (user.username === input.username) {
        throw new ServerDomainError(409, "USERNAME_TAKEN", "username already exists");
      }
    }
    const record: UserRecord = {
      ...input,
      createdAt: new Date().toISOString(),
      disabledAt: null
    };
    this.users.set(input.userId, record);
    return record;
  }

  async getUserByUsername(username: string): Promise<UserRecord | null> {
    for (const user of this.users.values()) {
      if (user.username === username) return user;
    }
    return null;
  }

  async getUserById(userId: string): Promise<UserRecord | null> {
    return this.users.get(userId) ?? null;
  }

  async createUserSession(input: {
    tokenHash: string;
    userId: string;
    expiresAt: string;
  }): Promise<void> {
    this.userSessions.set(input.tokenHash, {
      userId: input.userId,
      expiresAt: input.expiresAt,
      revokedAt: null
    });
  }

  async authenticateSessionHash(hash: string, now: string): Promise<UserRecord | null> {
    const session = this.userSessions.get(hash);
    if (session === undefined || session.revokedAt !== null || session.expiresAt <= now) {
      return null;
    }
    const user = this.users.get(session.userId);
    if (user === undefined || user.disabledAt !== null) return null;
    return user;
  }

  async revokeUserSession(hash: string): Promise<void> {
    const session = this.userSessions.get(hash);
    if (session !== undefined && session.revokedAt === null) {
      session.revokedAt = new Date().toISOString();
    }
  }

  async createInviteCode(input: {
    codeHash: string;
    createdBy: string;
    expiresAt: string;
  }): Promise<void> {
    this.inviteCodes.set(input.codeHash, {
      createdBy: input.createdBy,
      expiresAt: input.expiresAt,
      usedBy: null
    });
  }

  async consumeInviteCode(codeHash: string, usedBy: string, now: string): Promise<boolean> {
    const invite = this.inviteCodes.get(codeHash);
    if (invite === undefined || invite.usedBy !== null || invite.expiresAt <= now) {
      return false;
    }
    invite.usedBy = usedBy;
    return true;
  }

  async createProjectApiKey(input: {
    keyId: string;
    keyHash: string;
    projectId: string;
    actorId: string;
    label: string;
    scopes: ProjectKeyScope[];
    keyCiphertext?: string | null;
  }): Promise<ProjectApiKeyRecord> {
    const record: ProjectApiKeyRecord = {
      keyId: input.keyId,
      projectId: input.projectId,
      actorId: input.actorId,
      label: input.label,
      scopes: [...input.scopes],
      createdAt: new Date().toISOString(),
      revokedAt: null,
      lastUsedAt: null,
      keyCiphertext: input.keyCiphertext ?? null
    };
    this.projectApiKeys.set(input.keyHash, record);
    return record;
  }

  async listProjectApiKeys(projectId: string): Promise<ProjectApiKeyRecord[]> {
    return [...this.projectApiKeys.values()]
      .filter((key) => key.projectId === projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async revokeProjectApiKey(projectId: string, keyId: string): Promise<boolean> {
    for (const key of this.projectApiKeys.values()) {
      if (key.projectId === projectId && key.keyId === keyId && key.revokedAt === null) {
        key.revokedAt = new Date().toISOString();
        return true;
      }
    }
    return false;
  }

  async authenticateProjectKeyHash(
    keyHash: string,
    now: string
  ): Promise<ProjectApiKeyRecord | null> {
    const record = this.projectApiKeys.get(keyHash);
    if (record === undefined || record.revokedAt !== null) return null;
    record.lastUsedAt = now;
    return record;
  }

  async upsertKnowledgeEntry(input: {
    projectId: string;
    entryId: string;
    contentSha256: string;
    payload: Record<string, unknown>;
    status: string;
    allowDeprecatedOverwrite?: boolean;
  }): Promise<"created" | "updated" | "duplicate"> {
    const key = input.projectId + "\0" + input.entryId;
    const existing = this.knowledgeEntries.get(key);
    const now = new Date().toISOString();
    if (existing === undefined) {
      this.knowledgeEntries.set(key, {
        projectId: input.projectId,
        entryId: input.entryId,
        contentSha256: input.contentSha256,
        payload: input.payload,
        status: input.status,
        createdAt: now,
        updatedAt: now,
        projectedAt: null
      });
      return "created";
    }
    if (existing.contentSha256 === input.contentSha256 && existing.status === input.status) {
      return "duplicate";
    }
    if (existing.contentSha256 === input.contentSha256) return "duplicate";
    const stickyDeprecated =
      existing.status === "deprecated" && input.allowDeprecatedOverwrite !== true;
    existing.contentSha256 = input.contentSha256;
    existing.payload = stickyDeprecated
      ? { ...input.payload, status: "deprecated" }
      : input.payload;
    existing.status = stickyDeprecated ? "deprecated" : input.status;
    existing.updatedAt = now;
    existing.projectedAt = null;
    return "updated";
  }

  async listUnprojectedKnowledge(
    projectId: string,
    limit: number
  ): Promise<KnowledgeIngestRecord[]> {
    return [...this.knowledgeEntries.values()]
      .filter((entry) => entry.projectId === projectId && entry.projectedAt === null)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .slice(0, limit);
  }

  async markKnowledgeProjected(
    projectId: string,
    entryIds: string[],
    at: string
  ): Promise<void> {
    for (const entryId of entryIds) {
      const record = this.knowledgeEntries.get(projectId + "\0" + entryId);
      if (record !== undefined) record.projectedAt = at;
    }
  }

  async listKnowledgeEntries(input: {
    projectId: string;
    status?: string;
    limit: number;
  }): Promise<KnowledgeIngestRecord[]> {
    return [...this.knowledgeEntries.values()]
      .filter((entry) => entry.projectId === input.projectId &&
        (input.status === undefined || entry.status === input.status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, input.limit);
  }

  async updateKnowledgeStatus(
    projectId: string,
    entryId: string,
    status: string
  ): Promise<KnowledgeIngestRecord | null> {
    const record = this.knowledgeEntries.get(projectId + "\0" + entryId);
    if (record === undefined) return null;
    record.status = status;
    record.payload = { ...record.payload, status };
    record.updatedAt = new Date().toISOString();
    record.projectedAt = null;
    return record;
  }

  async resolveProject(input: {
    actorId: string;
    localProjectKey: string;
    displayName: string;
    requestedProjectId: string | null;
    recreate?: boolean;
  }): Promise<{ project: ProjectRecord; bindingStatus: "created" | "bound" }> {
    const bindingKey = input.actorId + "\0" + input.localProjectKey;
    const boundId = this.bindings.get(bindingKey);
    if (boundId !== undefined) {
      const bound = this.projects.get(boundId);
      if (bound !== undefined && bound.lifecycleState === "purged") {
        if (input.recreate === true) {
          this.bindings.delete(bindingKey);
        } else {
          throw new ServerDomainError(
            409,
            "PROJECT_PURGED",
            "local project key is bound to a purged project; pass recreate=true to create a replacement",
            { recreate_required: true, purged_project_id: boundId }
          );
        }
      } else {
        if (input.requestedProjectId !== null && input.requestedProjectId !== boundId) {
          throw new ServerDomainError(
            409,
            "PROJECT_BINDING_CONFLICT",
            "local project key is already bound"
          );
        }
        return { project: this.requireProject(input.actorId, boundId), bindingStatus: "bound" };
      }
    }

    if (input.requestedProjectId !== null) {
      const requested = this.projects.get(input.requestedProjectId);
      if (requested === undefined || requested.ownerActorId !== input.actorId) {
        throw new ServerDomainError(
          403,
          "PROJECT_BIND_FORBIDDEN",
          "requested project is not owned by the actor"
        );
      }
      this.bindings.set(bindingKey, requested.projectId);
      return { project: this.requireProject(input.actorId, requested.projectId), bindingStatus: "bound" };
    }

    const projectId = "prj_" + String(++this.counters.project).padStart(8, "0");
    const now = new Date().toISOString();
    const project: ProjectRecord = {
      projectId,
      ownerActorId: input.actorId,
      displayName: input.displayName,
      latestProjectVersion: null,
      latestArtifactId: null,
      lifecycleState: "active",
      archivedAt: null,
      purgeAfter: null,
      purgedAt: null,
      currentFilesVersion: null,
      currentFileCount: 0,
      updatedAt: now,
      createdAt: now
    };
    this.projects.set(projectId, project);
    this.bindings.set(bindingKey, projectId);
    return { project, bindingStatus: "created" };
  }

  async createProject(input: {
    actorId: string;
    displayName: string;
  }): Promise<ProjectRecord> {
    const projectId = "prj_" + String(++this.counters.project).padStart(8, "0");
    const now = new Date().toISOString();
    const project: ProjectRecord = {
      projectId,
      ownerActorId: input.actorId,
      displayName: input.displayName,
      latestProjectVersion: null,
      latestArtifactId: null,
      lifecycleState: "active",
      archivedAt: null,
      purgeAfter: null,
      purgedAt: null,
      currentFilesVersion: null,
      currentFileCount: 0,
      updatedAt: now,
      createdAt: now
    };
    this.projects.set(projectId, project);
    return structuredClone(project);
  }

  private requireOwnedProject(actorId: string, projectId: string): ProjectRecord {
    const project = this.projects.get(projectId);
    if (project === undefined || project.ownerActorId !== actorId) {
      throw new ServerDomainError(404, "PROJECT_NOT_FOUND", "project not found");
    }
    return project;
  }

  private requireProject(actorId: string, projectId: string): ProjectRecord {
    const project = this.requireOwnedProject(actorId, projectId);
    if (project.lifecycleState === "archived") {
      throw new ServerDomainError(410, "PROJECT_ARCHIVED", "project is in the recycle bin", {
        purge_after: project.purgeAfter
      });
    }
    if (project.lifecycleState === "purged") {
      throw new ServerDomainError(410, "PROJECT_PURGED", "project data was permanently purged");
    }
    return project;
  }

  async getProject(actorId: string, projectId: string): Promise<ProjectRecord> {
    return this.requireProject(actorId, projectId);
  }

  async listProjects(input: {
    actorId: string;
    limit: number;
    cursor: string | null;
    state?: "active" | "archived";
  }): Promise<{
    items: Array<ProjectRecord & { localProjectKey: string | null }>;
    nextCursor: string | null;
  }> {
    const offset = input.cursor === null
      ? 0
      : Number.parseInt(Buffer.from(input.cursor, "base64url").toString("utf8"), 10);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new ServerDomainError(400, "INVALID_CURSOR", "cursor is invalid");
    }
    const localKeyByProject = new Map<string, string>();
    for (const [bindingKey, projectId] of this.bindings) {
      if (!bindingKey.startsWith(input.actorId + "\0")) continue;
      const localKey = bindingKey.slice(input.actorId.length + 1);
      if (!localKeyByProject.has(projectId)) localKeyByProject.set(projectId, localKey);
    }
    const values = [...this.projects.values()]
      .filter((project) => project.ownerActorId === input.actorId &&
        project.lifecycleState === (input.state ?? "active"))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) ||
        right.projectId.localeCompare(left.projectId));
    const items = values.slice(offset, offset + input.limit).map((project) => ({
      ...project,
      localProjectKey: localKeyByProject.get(project.projectId) ?? null
    }));
    const nextOffset = offset + items.length;
    return {
      items,
      nextCursor: nextOffset < values.length
        ? Buffer.from(String(nextOffset)).toString("base64url")
        : null
    };
  }

  async archiveProject(actorId: string, projectId: string, archivedAt: string): Promise<ProjectRecord> {
    const project = this.requireOwnedProject(actorId, projectId);
    if (project.lifecycleState === "purged") {
      throw new ServerDomainError(410, "PROJECT_PURGED", "project data was permanently purged");
    }
    if (project.lifecycleState === "active") {
      project.lifecycleState = "archived";
      project.archivedAt = archivedAt;
      project.purgeAfter = new Date(Date.parse(archivedAt) + 30 * 24 * 60 * 60 * 1000).toISOString();
      project.updatedAt = archivedAt;
    }
    return structuredClone(project);
  }

  async restoreProject(actorId: string, projectId: string): Promise<ProjectRecord> {
    const project = this.requireOwnedProject(actorId, projectId);
    if (project.lifecycleState === "purged") {
      throw new ServerDomainError(410, "PROJECT_PURGED", "project data was permanently purged");
    }
    project.lifecycleState = "active";
    project.archivedAt = null;
    project.purgeAfter = null;
    project.updatedAt = new Date().toISOString();
    return structuredClone(project);
  }

  async purgeProject(actorId: string, projectId: string, purgedAt: string): Promise<ProjectRecord> {
    const project = this.requireOwnedProject(actorId, projectId);
    if (project.lifecycleState === "purged") return structuredClone(project);
    if (project.lifecycleState !== "archived") {
      throw new ServerDomainError(409, "PROJECT_NOT_ARCHIVED", "project must be archived before purge");
    }
    for (const [sessionId, session] of this.sessions) {
      if (session.projectId === projectId) this.sessions.delete(sessionId);
    }
    for (const [proposalId, proposal] of this.proposals) {
      if (proposal.projectId === projectId) this.proposals.delete(proposalId);
    }
    for (const [artifactId, artifact] of this.artifacts) {
      if (artifact.projectId === projectId) this.artifacts.delete(artifactId);
    }
    for (const [key, archive] of this.archivePackages) {
      if (archive.projectId === projectId) this.archivePackages.delete(key);
    }
    // Keep bindings as tombstones so resolve cannot silently recreate (S7).
    this.projectFiles.delete(projectId);
    project.latestProjectVersion = null;
    project.latestArtifactId = null;
    project.lifecycleState = "purged";
    project.purgedAt = purgedAt;
    project.purgeAfter = null;
    project.currentFilesVersion = null;
    project.currentFileCount = 0;
    project.updatedAt = purgedAt;
    return structuredClone(project);
  }

  async purgeExpiredProjects(now: string): Promise<Array<{
    project: ProjectRecord;
    contentSha256: string[];
  }>> {
    const expired = [...this.projects.values()].filter((project) =>
      project.lifecycleState === "archived" &&
      project.purgeAfter !== null &&
      Date.parse(project.purgeAfter) <= Date.parse(now)
    ).sort((left, right) => (left.purgeAfter ?? "").localeCompare(right.purgeAfter ?? "") ||
      left.projectId.localeCompare(right.projectId)).slice(0, 100);
    const purged: Array<{ project: ProjectRecord; contentSha256: string[] }> = [];
    for (const project of expired) {
      const contentSha256 = await this.listProjectBlobHashes(project.ownerActorId, project.projectId);
      purged.push({
        project: await this.purgeProject(project.ownerActorId, project.projectId, now),
        contentSha256
      });
    }
    return purged;
  }

  async listProjectBlobHashes(actorId: string, projectId: string): Promise<string[]> {
    this.requireOwnedProject(actorId, projectId);
    return [...new Set([
      ...[...this.artifacts.values()]
        .filter((artifact) => artifact.projectId === projectId)
        .flatMap((artifact) => artifact.manifest.files.flatMap((operation) =>
          operation.operation === "delete" ? [] : [operation.content_sha256]
        )),
      ...[...this.sessions.values()]
        .filter((session) => session.projectId === projectId)
        .flatMap((session) => session.operations.flatMap((operation) =>
          operation.operation === "delete" ? [] : [operation.content_sha256]
        )),
      ...[...this.archivePackages.values()]
        .filter((archive) => archive.projectId === projectId)
        .flatMap((archive) => [archive.packageSha256, ...archive.coreContentSha256])
    ])];
  }

  async isBlobReferenced(contentSha256: string): Promise<boolean> {
    return [...this.artifacts.values()].some((artifact) => artifact.manifest.files.some((operation) =>
      operation.operation !== "delete" && operation.content_sha256 === contentSha256
    )) || [...this.sessions.values()].some((session) =>
      session.status === "open" &&
      Date.parse(session.expiresAt) > Date.now() &&
      session.operations.some((operation) =>
        operation.operation !== "delete" && operation.content_sha256 === contentSha256
      )
    ) || [...this.archivePackages.values()].some(
      (archive) => archive.packageSha256 === contentSha256 ||
        archive.coreContentSha256.includes(contentSha256)
    );
  }

  private ensureProjectFiles(project: ProjectRecord): ProjectFileRecord[] {
    const cached = [...(this.projectFiles.get(project.projectId)?.values() ?? [])];
    if (project.currentFilesVersion === project.latestProjectVersion) {
      return cached.sort((left, right) => left.path.localeCompare(right.path));
    }
    let files: ProjectFileRecord[] = [];
    const artifacts = [...this.artifacts.values()]
      .filter((artifact) => artifact.projectId === project.projectId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) ||
        left.artifactId.localeCompare(right.artifactId));
    for (const artifact of artifacts) {
      files = applyProjectFileOperations(
        files,
        artifact.manifest.files,
        artifact.projectVersion,
        artifact.createdAt,
        false
      ).map((file) => ({ ...file, projectId: project.projectId }));
    }
    this.projectFiles.set(project.projectId, new Map(files.map((file) => [file.path, file])));
    project.currentFilesVersion = project.latestProjectVersion;
    project.currentFileCount = files.length;
    return files;
  }

  async listProjectFiles(actorId: string, projectId: string): Promise<ProjectFileRecord[]> {
    const project = this.requireProject(actorId, projectId);
    return structuredClone(this.ensureProjectFiles(project));
  }

  async getProjectFile(
    actorId: string,
    projectId: string,
    path: string
  ): Promise<ProjectFileRecord> {
    const file = (await this.listProjectFiles(actorId, projectId)).find((item) => item.path === path);
    if (file === undefined) {
      throw new ServerDomainError(404, "PROJECT_FILE_NOT_FOUND", "project file not found", { path });
    }
    return file;
  }

  async putChangeArchivePackage(input: {
    actorId: string;
    projectId: string;
    changeKey: string;
    packageSha256: string;
    manifestSha256: string;
    coreContentSha256: string[];
    storedFiles: number;
  }): Promise<{ record: ChangeArchivePackageRecord; created: boolean }> {
    this.requireOwnedProject(input.actorId, input.projectId);
    const key = input.projectId + "\0" + input.changeKey;
    const existing = this.archivePackages.get(key);
    if (existing !== undefined) {
      return { record: structuredClone(existing), created: false };
    }
    const now = new Date().toISOString();
    const record: ChangeArchivePackageRecord = {
      archiveId: "arc_" + String(++this.counters.archive).padStart(8, "0"),
      projectId: input.projectId,
      changeKey: input.changeKey,
      packageSha256: input.packageSha256,
      manifestSha256: input.manifestSha256,
      coreContentSha256: [...new Set(input.coreContentSha256)],
      artifactId: null,
      archiveStatus: "durable",
      knowledgeStatus: "indexing",
      attemptCount: 1,
      failureStage: null,
      lastErrorCode: null,
      storedFiles: input.storedFiles,
      createdAt: now,
      updatedAt: now
    };
    this.archivePackages.set(key, record);
    return { record: structuredClone(record), created: true };
  }

  async getChangeArchivePackage(
    actorId: string,
    projectId: string,
    changeKey: string
  ): Promise<ChangeArchivePackageRecord> {
    this.requireOwnedProject(actorId, projectId);
    const record = this.archivePackages.get(projectId + "\0" + changeKey);
    if (record === undefined) {
      throw new ServerDomainError(404, "ARCHIVE_PACKAGE_NOT_FOUND", "archive package not found");
    }
    return structuredClone(record);
  }

  async getChangeArchivePackages(
    actorId: string,
    projectId: string,
    changeKeys: readonly string[]
  ): Promise<ChangeArchivePackageRecord[]> {
    this.requireOwnedProject(actorId, projectId);
    const records: ChangeArchivePackageRecord[] = [];
    for (const changeKey of new Set(changeKeys)) {
      const record = this.archivePackages.get(projectId + "\0" + changeKey);
      if (record !== undefined) records.push(structuredClone(record));
    }
    return records;
  }

  async updateChangeArchivePackage(input: {
    actorId: string;
    projectId: string;
    changeKey: string;
    artifactId: string | null;
    knowledgeStatus: ChangeArchivePackageRecord["knowledgeStatus"];
    failureStage: ChangeArchivePackageRecord["failureStage"];
    lastErrorCode: string | null;
    coreContentSha256?: string[];
    incrementAttempt?: boolean;
  }): Promise<ChangeArchivePackageRecord> {
    const record = await this.getChangeArchivePackage(
      input.actorId,
      input.projectId,
      input.changeKey
    );
    record.artifactId = input.artifactId;
    record.knowledgeStatus = input.knowledgeStatus;
    record.failureStage = input.failureStage;
    record.lastErrorCode = input.lastErrorCode;
    if (input.coreContentSha256 !== undefined) {
      record.coreContentSha256 = [...new Set(input.coreContentSha256)];
    }
    if (input.incrementAttempt === true) record.attemptCount += 1;
    record.updatedAt = new Date().toISOString();
    this.archivePackages.set(input.projectId + "\0" + input.changeKey, record);
    return structuredClone(record);
  }

  async createProposalSession(
    input: Omit<ProposalSessionRecord, "sessionId">
  ): Promise<ProposalSessionRecord> {
    this.requireProject(input.actorId, input.projectId);
    const session: ProposalSessionRecord = {
      ...input,
      sessionId: "ups_" + String(++this.counters.session).padStart(8, "0")
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }

  async getProposalSession(actorId: string, sessionId: string): Promise<ProposalSessionRecord> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new ServerDomainError(404, "UPLOAD_SESSION_NOT_FOUND", "upload session not found");
    }
    this.requireProject(actorId, session.projectId);
    if (Date.parse(session.expiresAt) <= Date.now()) {
      throw new ServerDomainError(410, "UPLOAD_SESSION_EXPIRED", "upload session expired");
    }
    return session;
  }

  async updateProposalSession(session: ProposalSessionRecord): Promise<void> {
    this.sessions.set(session.sessionId, session);
  }

  async createProposalFromSession(session: ProposalSessionRecord): Promise<ProposalRecord> {
    if (session.status !== "open") {
      throw new ServerDomainError(409, "UPLOAD_SESSION_FINALIZED", "session is already finalized");
    }
    const proposal: ProposalRecord = {
      proposalId: "prp_" + String(++this.counters.proposal).padStart(8, "0"),
      projectId: session.projectId,
      createdBy: session.actorId,
      baseProjectVersion: session.baseProjectVersion,
      baseManifestHash: session.baseManifestHash,
      status: "pending_review",
      items: session.operations.map((operation) => ({
        itemId: "item_" + String(++this.counters.item).padStart(8, "0"),
        operation
      })),
      createdAt: new Date().toISOString(),
      parentProposalId: null,
      reviewHistory: []
    };
    session.status = "finalized";
    this.proposals.set(proposal.proposalId, proposal);
    this.sessions.set(session.sessionId, session);
    return proposal;
  }

  async finalizeSessionAutoApprove(session: ProposalSessionRecord): Promise<{
    proposal: ProposalRecord;
    review: ReviewRecord;
  }> {
    const project = this.requireProject(session.actorId, session.projectId);
    const currentFiles = this.ensureProjectFiles(project);
    applyProjectFileOperations(
      currentFiles,
      session.operations,
      "pv_preview",
      new Date().toISOString()
    );
    const proposal = await this.createProposalFromSession(session);
    const review = await this.reviewProposal({
      actorId: session.actorId,
      proposalId: proposal.proposalId,
      decision: "auto-approved",
      comment: null,
      targetScope: "auto-approved",
      splitGroups: []
    });
    if (review.artifactId !== null) {
      const artifact = await this.getArtifact(session.actorId, review.artifactId);
      const nextFiles = applyProjectFileOperations(
        currentFiles,
        session.operations,
        artifact.projectVersion,
        artifact.createdAt
      ).map((file) => ({ ...file, projectId: session.projectId }));
      this.projectFiles.set(session.projectId, new Map(nextFiles.map((file) => [file.path, file])));
      project.currentFilesVersion = artifact.projectVersion;
      project.currentFileCount = nextFiles.length;
      project.updatedAt = artifact.createdAt;
    }
    return { proposal: this.requireProposal(session.actorId, proposal.proposalId), review };
  }

  private requireProposal(actorId: string, proposalId: string): ProposalRecord {
    const proposal = this.proposals.get(proposalId);
    if (proposal === undefined) {
      throw new ServerDomainError(404, "PROPOSAL_NOT_FOUND", "proposal not found");
    }
    this.requireProject(actorId, proposal.projectId);
    return proposal;
  }

  async getProposal(actorId: string, proposalId: string): Promise<ProposalRecord> {
    return this.requireProposal(actorId, proposalId);
  }

  async listProposals(input: {
    actorId: string;
    projectId: string;
    limit: number;
    cursor: string | null;
    status: string | null;
  }): Promise<{ items: ProposalRecord[]; nextCursor: string | null }> {
    this.requireProject(input.actorId, input.projectId);
    let offset = 0;
    if (input.cursor !== null) {
      try {
        offset = Number.parseInt(Buffer.from(input.cursor, "base64url").toString("utf8"), 10);
      } catch {
        throw new ServerDomainError(400, "INVALID_CURSOR", "cursor is invalid");
      }
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new ServerDomainError(400, "INVALID_CURSOR", "cursor is invalid");
      }
    }
    const values = [...this.proposals.values()]
      .filter((proposal) => proposal.projectId === input.projectId &&
        (input.status === null || proposal.status === input.status))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) ||
        right.proposalId.localeCompare(left.proposalId));
    const items = values.slice(offset, offset + input.limit);
    const nextOffset = offset + items.length;
    return {
      items,
      nextCursor: nextOffset < values.length
        ? Buffer.from(String(nextOffset)).toString("base64url")
        : null
    };
  }

  async reviewProposal(input: {
    actorId: string;
    proposalId: string;
    decision: ReviewRecord["decision"];
    comment: string | null;
    targetScope: string;
    splitGroups: Array<{ name: string; itemIds: string[]; targetScope: string }>;
  }): Promise<ReviewRecord> {
    const proposal = this.requireProposal(input.actorId, input.proposalId);
    if (proposal.status !== "pending_review") {
      throw new ServerDomainError(409, "PROPOSAL_NOT_REVIEWABLE", "proposal is not pending review");
    }
    let artifactId: string | null = null;
    const childProposalIds: string[] = [];
    if (input.decision === "approve" || input.decision === "auto-approved") {
      const project = this.requireProject(input.actorId, proposal.projectId);
      if (proposal.parentProposalId === null &&
          proposal.baseProjectVersion !== project.latestProjectVersion) {
        throw new ServerDomainError(
          409,
          "PROJECT_VERSION_CONFLICT",
          "proposal base version is stale"
        );
      }
      if (proposal.parentProposalId !== null) {
        proposal.baseProjectVersion = project.latestProjectVersion;
      }
      const projectVersion = "pv_" + String(++this.counters.version).padStart(8, "0");
      artifactId = "art_" + String(++this.counters.artifact).padStart(8, "0");
      const payload = {
        schema_version: 1 as const,
        project_id: project.projectId,
        project_version: projectVersion,
        artifact_id: artifactId,
        files: proposal.items.map((item) => item.operation)
      };
      const manifest = artifactManifestSchema.parse({
        ...payload,
        manifest_sha256: sha256Bytes(canonicalJson(payload))
      });
      const artifact: ArtifactRecord = {
        artifactId,
        projectId: project.projectId,
        projectVersion,
        baseProjectVersion: proposal.baseProjectVersion,
        proposalId: proposal.proposalId,
        manifest,
        createdAt: new Date().toISOString()
      };
      this.artifacts.set(artifactId, artifact);
      project.latestProjectVersion = projectVersion;
      project.latestArtifactId = artifactId;
      proposal.status = "approved";
    } else if (input.decision === "reject") {
      proposal.status = "rejected";
    } else if (input.decision === "need_more_evidence") {
      proposal.status = "needs_evidence";
    } else {
      const allItemIds = new Set(proposal.items.map((item) => item.itemId));
      const assignedIds = input.splitGroups.flatMap((group) => group.itemIds);
      if (input.splitGroups.length < 2 ||
          assignedIds.length !== allItemIds.size ||
          new Set(assignedIds).size !== assignedIds.length ||
          assignedIds.some((itemId) => !allItemIds.has(itemId))) {
        throw new ServerDomainError(400, "VALIDATION_FAILED", "split requires at least two groups");
      }
      for (const group of input.splitGroups) {
        const child: ProposalRecord = {
          ...proposal,
          proposalId: "prp_" + String(++this.counters.proposal).padStart(8, "0"),
          status: "pending_review",
          items: proposal.items.filter((item) => group.itemIds.includes(item.itemId)),
          createdAt: new Date().toISOString(),
          parentProposalId: proposal.proposalId,
          reviewHistory: []
        };
        this.proposals.set(child.proposalId, child);
        childProposalIds.push(child.proposalId);
      }
      proposal.status = "split";
    }

    const review: ReviewRecord = {
      reviewId: "rev_" + String(++this.counters.review).padStart(8, "0"),
      proposalId: proposal.proposalId,
      actorId: input.actorId,
      decision: input.decision,
      comment: input.comment,
      targetScope: input.targetScope,
      createdAt: new Date().toISOString(),
      artifactId,
      childProposalIds
    };
    proposal.reviewHistory.push(review);
    return review;
  }

  async getArtifact(actorId: string, artifactId: string): Promise<ArtifactRecord> {
    const artifact = this.artifacts.get(artifactId);
    if (artifact === undefined) {
      throw new ServerDomainError(404, "ARTIFACT_NOT_FOUND", "artifact not found");
    }
    this.requireProject(actorId, artifact.projectId);
    return artifact;
  }

  async getLatestArtifact(actorId: string, projectId: string): Promise<ArtifactRecord | null> {
    const project = this.requireProject(actorId, projectId);
    return project.latestArtifactId === null
      ? null
      : this.getArtifact(actorId, project.latestArtifactId);
  }

  async getNextArtifact(
    actorId: string,
    projectId: string,
    baseProjectVersion: string | null
  ): Promise<ArtifactRecord | null> {
    this.requireProject(actorId, projectId);
    return [...this.artifacts.values()]
      .filter((artifact) => artifact.projectId === projectId &&
        artifact.baseProjectVersion === baseProjectVersion)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) ||
        left.artifactId.localeCompare(right.artifactId))[0] ?? null;
  }

  async listArtifacts(input: {
    actorId: string;
    projectId: string;
    limit: number;
    cursor: string | null;
  }): Promise<{ items: ArtifactRecord[]; nextCursor: string | null }> {
    this.requireProject(input.actorId, input.projectId);
    const offset = input.cursor === null
      ? 0
      : Number.parseInt(Buffer.from(input.cursor, "base64url").toString("utf8"), 10);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new ServerDomainError(400, "INVALID_CURSOR", "cursor is invalid");
    }
    const values = [...this.artifacts.values()]
      .filter((artifact) => artifact.projectId === input.projectId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) ||
        right.artifactId.localeCompare(left.artifactId));
    const items = values.slice(offset, offset + input.limit);
    return {
      items,
      nextCursor: offset + items.length < values.length
        ? Buffer.from(String(offset + items.length)).toString("base64url")
        : null
    };
  }

  async appendAudit(
    event: Omit<AuditEvent, "eventId" | "createdAt">
  ): Promise<AuditEvent> {
    const stored: AuditEvent = {
      ...event,
      eventId: "evt_" + String(++this.counters.event).padStart(8, "0"),
      createdAt: new Date().toISOString()
    };
    this.auditEvents.push(stored);
    return stored;
  }

  // TransactionRepository 使用隔离的写集，成功时一次合并；失败时直接丢弃。
  // 这样事务回滚不会抹掉同时完成的非事务 audit/idempotency 写入。
  async withTransaction<T>(fn: (tx: TransactionRepository) => Promise<T>): Promise<T> {
    const previous = this.transactionTail;
    let release: (() => void) | undefined;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    let registryState = structuredClone(this.registryState);
    let registryChanged = false;
    const auditEvents: AuditEvent[] = [];
    const idempotency = new Map<string, IdempotencyRecord>();
    const tx: TransactionRepository = {
      appendAudit: async (event) => {
        const stored: AuditEvent = {
          ...event,
          eventId: "evt_" + String(++this.counters.event).padStart(8, "0"),
          createdAt: new Date().toISOString()
        };
        auditEvents.push(stored);
        return structuredClone(stored);
      },
      saveRegistryState: async (snapshot) => {
        registryState = structuredClone(snapshot);
        registryChanged = true;
      },
      loadRegistryState: async () => structuredClone(registryState),
      getIdempotency: async (input) => {
        const key = this.idempotencyKey(input);
        return structuredClone(idempotency.get(key) ?? this.idempotency.get(key) ?? null);
      },
      putIdempotency: async (record) => {
        idempotency.set(this.idempotencyKey(record), structuredClone(record));
      }
    };
    try {
      const result = await fn(tx);
      if (registryChanged) this.registryState = registryState;
      this.auditEvents.push(...auditEvents);
      for (const [key, record] of idempotency) this.idempotency.set(key, record);
      return result;
    } finally {
      release?.();
    }
  }

  // memory 模式 registry 真相在 RegistryStore 内存 Map（不走 DB）；
  // save/loadRegistryState 满足 ServerRepository 接口契约，存进程内（不持久，重启丢）。
  private registryState: unknown = null;
  async saveRegistryState(snapshot: unknown): Promise<void> {
    this.registryState = snapshot;
  }

  async loadRegistryState(): Promise<unknown | null> {
    return this.registryState;
  }

  async listAuditEvents(input?: { actorId: string; limit: number }): Promise<AuditEvent[]> {
    const events = this.auditEvents
      .filter((event) => input === undefined || event.actorId === input.actorId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.eventId.localeCompare(left.eventId));
    return structuredClone(input === undefined ? events : events.slice(0, input.limit));
  }

  private idempotencyKey(input: {
    actorId: string;
    method: string;
    path: string;
    key: string;
  }): string {
    return [input.actorId, input.method, input.path, input.key].join("\0");
  }

  async getIdempotency(input: {
    actorId: string;
    method: string;
    path: string;
    key: string;
  }): Promise<IdempotencyRecord | null> {
    return this.idempotency.get(this.idempotencyKey(input)) ?? null;
  }

  async putIdempotency(record: IdempotencyRecord): Promise<void> {
    this.idempotency.set(this.idempotencyKey(record), structuredClone(record));
  }
}
