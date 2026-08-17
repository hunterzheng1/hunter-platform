import type { ArtifactManifest, FileOperation } from "@hunter-harness/contracts";
import type { FindingOverride } from "@hunter-harness/core";

export class ServerDomainError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "ServerDomainError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface Actor {
  actorId: string;
}

export interface UserRecord {
  userId: string;
  username: string;
  displayName: string;
  passwordHash: string;
  actorId: string;
  createdAt: string;
  disabledAt: string | null;
}

export interface UserSessionRecord {
  userId: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface NpmPublishingCredentialRecord {
  schemaVersion: 1;
  keyId: string;
  ciphertext: string;
  iv: string;
  authTag: string;
  scope: string;
  username: string;
  expiresAt: string | null;
  lastVerifiedAt: string;
  updatedBy: string;
  updatedAt: string;
}

export const PROJECT_KEY_SCOPES = [
  "push",
  "knowledge:read",
  "knowledge:write",
  "progress:write",
  "platform:read",
  "files:read",
  "files:write"
  ,"archive:read",
  "archive:write"
] as const;

export type ProjectKeyScope = (typeof PROJECT_KEY_SCOPES)[number];

export interface KnowledgeIngestRecord {
  projectId: string;
  entryId: string;
  contentSha256: string;
  payload: Record<string, unknown>;
  status: string;
  createdAt: string;
  updatedAt: string;
  projectedAt: string | null;
}

export interface ChangeArchivePackageRecord {
  archiveId: string;
  projectId: string;
  changeKey: string;
  packageSha256: string;
  manifestSha256: string;
  coreContentSha256: string[];
  artifactId: string | null;
  archiveStatus: "durable";
  knowledgeStatus: "indexing" | "ready" | "failed";
  attemptCount: number;
  failureStage: "raw_storage" | "core_storage" | "finalize" | "semantic" | null;
  lastErrorCode: string | null;
  storedFiles: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectApiKeyRecord {
  keyId: string;
  projectId: string;
  actorId: string;
  label: string;
  scopes: ProjectKeyScope[];
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  /**
   * AES-256-GCM 密文（v1.<iv>.<tag>.<ct> base64 段）。为 null 表示该 key 创建时
   * 未配置 HUNTER_HARNESS_CREDENTIAL_KEY，永远无法再次查看明文。
   */
  keyCiphertext: string | null;
}

export interface ProjectRecord {
  projectId: string;
  ownerActorId: string;
  displayName: string;
  latestProjectVersion: string | null;
  latestArtifactId: string | null;
  lifecycleState: "active" | "archived" | "purged";
  archivedAt: string | null;
  purgeAfter: string | null;
  purgedAt: string | null;
  currentFilesVersion: string | null;
  currentFileCount: number;
  updatedAt: string;
  createdAt: string;
}

export interface ProjectFileRecord {
  projectId: string;
  path: string;
  fileKind: FileOperation["file_kind"];
  contentSha256: string;
  sizeBytes: number;
  projectVersion: string;
  updatedAt: string;
}

export interface ProposalSessionRecord {
  sessionId: string;
  projectId: string;
  actorId: string;
  baseProjectVersion: string | null;
  baseManifestHash: string;
  operations: FileOperation[];
  scanOverrides: FindingOverride[];
  status: "open" | "finalized" | "failed";
  expiresAt: string;
  maxChunkBytes: number;
}

export interface ProposalItemRecord {
  itemId: string;
  operation: FileOperation;
}

export type ProposalStatus =
  | "pending_review"
  | "approved"
  | "rejected"
  | "needs_evidence"
  | "split";

export interface ProposalRecord {
  proposalId: string;
  projectId: string;
  createdBy: string;
  baseProjectVersion: string | null;
  baseManifestHash: string;
  status: ProposalStatus;
  items: ProposalItemRecord[];
  createdAt: string;
  parentProposalId: string | null;
  reviewHistory: ReviewRecord[];
}

export interface ReviewRecord {
  reviewId: string;
  proposalId: string;
  actorId: string;
  decision: "approve" | "reject" | "need_more_evidence" | "split" | "auto-approved";
  comment: string | null;
  targetScope: string;
  createdAt: string;
  artifactId: string | null;
  childProposalIds: string[];
}

export interface ArtifactRecord {
  artifactId: string;
  projectId: string;
  projectVersion: string;
  baseProjectVersion: string | null;
  proposalId: string;
  manifest: ArtifactManifest;
  createdAt: string;
}

export interface AuditEvent {
  eventId: string;
  actorId: string;
  projectId: string | null;
  action: string;
  targetId: string;
  requestId: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface IdempotencyRecord {
  actorId: string;
  method: string;
  path: string;
  key: string;
  bodyHash: string;
  statusCode: number;
  response: unknown;
}

// 事务内可用的 ServerRepository 子集视图（PgTransactionRepository 绑定 PoolClient 实现走 client）。
// publish 路由 withTransaction 内的 writeAudit / persist / idempotency 通过此接口。
export interface TransactionRepository {
  appendAudit(event: Omit<AuditEvent, "eventId" | "createdAt">): Promise<AuditEvent>;
  saveRegistryState(snapshot: unknown): Promise<void>;
  loadRegistryState(): Promise<unknown | null>;
  getIdempotency(input: {
    actorId: string;
    method: string;
    path: string;
    key: string;
  }): Promise<IdempotencyRecord | null>;
  putIdempotency(record: IdempotencyRecord): Promise<void>;
}

export interface ServerRepository extends TransactionRepository {
  withTransaction<T>(fn: (tx: TransactionRepository) => Promise<T>): Promise<T>;
  acquireIdempotencyLock(input: {
    actorId: string;
    method: string;
    path: string;
    key: string;
  }): Promise<{ release(): Promise<void> }>;
  authenticateToken(token: string): Promise<Actor | null>;
  getNpmPublishingCredential(): Promise<NpmPublishingCredentialRecord | null>;
  saveNpmPublishingCredential(record: NpmPublishingCredentialRecord): Promise<void>;
  clearNpmPublishingCredential(): Promise<boolean>;
  resolveProject(input: {
    actorId: string;
    localProjectKey: string;
    displayName: string;
    requestedProjectId: string | null;
    /** Explicit recreate after purge — clears the tombstone binding first. */
    recreate?: boolean;
  }): Promise<{ project: ProjectRecord; bindingStatus: "created" | "bound" }>;
  /** Web/UI create: allocate an active project owned by the actor (no local binding). */
  createProject(input: {
    actorId: string;
    displayName: string;
  }): Promise<ProjectRecord>;
  getProject(actorId: string, projectId: string): Promise<ProjectRecord>;
  listProjects(input: {
    actorId: string;
    limit: number;
    cursor: string | null;
    state?: "active" | "archived";
  }): Promise<{
    items: Array<ProjectRecord & { localProjectKey: string | null }>;
    nextCursor: string | null;
  }>;
  archiveProject(actorId: string, projectId: string, archivedAt: string): Promise<ProjectRecord>;
  restoreProject(actorId: string, projectId: string): Promise<ProjectRecord>;
  purgeProject(actorId: string, projectId: string, purgedAt: string): Promise<ProjectRecord>;
  purgeExpiredProjects(now: string): Promise<Array<{
    project: ProjectRecord;
    contentSha256: string[];
  }>>;
  listProjectBlobHashes(actorId: string, projectId: string): Promise<string[]>;
  isBlobReferenced(contentSha256: string): Promise<boolean>;
  listProjectFiles(actorId: string, projectId: string): Promise<ProjectFileRecord[]>;
  getProjectFile(actorId: string, projectId: string, path: string): Promise<ProjectFileRecord>;
  putChangeArchivePackage(input: {
    actorId: string;
    projectId: string;
    changeKey: string;
    packageSha256: string;
    manifestSha256: string;
    coreContentSha256: string[];
    storedFiles: number;
  }): Promise<{ record: ChangeArchivePackageRecord; created: boolean }>;
  getChangeArchivePackage(
    actorId: string,
    projectId: string,
    changeKey: string
  ): Promise<ChangeArchivePackageRecord>;
  getChangeArchivePackages(
    actorId: string,
    projectId: string,
    changeKeys: readonly string[]
  ): Promise<ChangeArchivePackageRecord[]>;
  updateChangeArchivePackage(input: {
    actorId: string;
    projectId: string;
    changeKey: string;
    artifactId: string | null;
    knowledgeStatus: ChangeArchivePackageRecord["knowledgeStatus"];
    failureStage: ChangeArchivePackageRecord["failureStage"];
    lastErrorCode: string | null;
    coreContentSha256?: string[];
    incrementAttempt?: boolean;
  }): Promise<ChangeArchivePackageRecord>;
  createProposalSession(input: Omit<ProposalSessionRecord, "sessionId">): Promise<ProposalSessionRecord>;
  getProposalSession(actorId: string, sessionId: string): Promise<ProposalSessionRecord>;
  updateProposalSession(session: ProposalSessionRecord): Promise<void>;
  createProposalFromSession(session: ProposalSessionRecord): Promise<ProposalRecord>;
  /** finalize 同事务：创建 proposal 并 auto-approve 写 artifact + reviews.decision=auto-approved */
  finalizeSessionAutoApprove(session: ProposalSessionRecord): Promise<{
    proposal: ProposalRecord;
    review: ReviewRecord;
  }>;
  getProposal(actorId: string, proposalId: string): Promise<ProposalRecord>;
  listProposals(input: {
    actorId: string;
    projectId: string;
    limit: number;
    cursor: string | null;
    status: string | null;
  }): Promise<{ items: ProposalRecord[]; nextCursor: string | null }>;
  reviewProposal(input: {
    actorId: string;
    proposalId: string;
    decision: ReviewRecord["decision"];
    comment: string | null;
    targetScope: string;
    splitGroups: Array<{ name: string; itemIds: string[]; targetScope: string }>;
  }): Promise<ReviewRecord>;
  getArtifact(actorId: string, artifactId: string): Promise<ArtifactRecord>;
  getLatestArtifact(actorId: string, projectId: string): Promise<ArtifactRecord | null>;
  getNextArtifact(
    actorId: string,
    projectId: string,
    baseProjectVersion: string | null
  ): Promise<ArtifactRecord | null>;
  listArtifacts(input: {
    actorId: string;
    projectId: string;
    limit: number;
    cursor: string | null;
  }): Promise<{ items: ArtifactRecord[]; nextCursor: string | null }>;
  listAuditEvents(input: {
    actorId: string;
    limit: number;
  }): Promise<AuditEvent[]>;
  // --- P2 auth: human accounts + session tokens (machine access stays on api_tokens) ---
  countUsers(): Promise<number>;
  createUser(input: {
    userId: string;
    username: string;
    displayName: string;
    passwordHash: string;
    actorId: string;
  }): Promise<UserRecord>;
  getUserByUsername(username: string): Promise<UserRecord | null>;
  getUserById(userId: string): Promise<UserRecord | null>;
  createUserSession(input: {
    tokenHash: string;
    userId: string;
    expiresAt: string;
  }): Promise<void>;
  /** Resolve a session token hash to its user/actor; null when missing, expired, or revoked. */
  authenticateSessionHash(tokenHash: string, now: string): Promise<UserRecord | null>;
  revokeUserSession(tokenHash: string): Promise<void>;
  createInviteCode(input: {
    codeHash: string;
    createdBy: string;
    expiresAt: string;
  }): Promise<void>;
  /** Atomically mark an invite used; false when missing, expired, or already used. */
  consumeInviteCode(codeHash: string, usedBy: string, now: string): Promise<boolean>;
  // --- P2: project-scoped API keys ---
  createProjectApiKey(input: {
    keyId: string;
    keyHash: string;
    projectId: string;
    actorId: string;
    label: string;
    scopes: ProjectKeyScope[];
    keyCiphertext?: string | null;
  }): Promise<ProjectApiKeyRecord>;
  listProjectApiKeys(projectId: string): Promise<ProjectApiKeyRecord[]>;
  /** Returns false when the key does not exist or is already revoked. */
  revokeProjectApiKey(projectId: string, keyId: string): Promise<boolean>;
  /** Resolve a key hash to its record; null when missing or revoked. Touches last_used_at. */
  authenticateProjectKeyHash(keyHash: string, now: string): Promise<ProjectApiKeyRecord | null>;
  // --- P3: server-side knowledge ingest (idempotent, hash-deduped outbox) ---
  /**
   * Idempotent upsert keyed by (projectId, entryId):
   * "duplicate" when the content hash is unchanged, otherwise created/updated
   * and the row re-enters the projection outbox (projected_at = NULL).
   * When the existing status is `deprecated`, content updates keep deprecated
   * unless `allowDeprecatedOverwrite` is true (explicit revive path).
   */
  upsertKnowledgeEntry(input: {
    projectId: string;
    entryId: string;
    contentSha256: string;
    payload: Record<string, unknown>;
    status: string;
    allowDeprecatedOverwrite?: boolean;
  }): Promise<"created" | "updated" | "duplicate">;
  listUnprojectedKnowledge(projectId: string, limit: number): Promise<KnowledgeIngestRecord[]>;
  markKnowledgeProjected(projectId: string, entryIds: string[], at: string): Promise<void>;
  listKnowledgeEntries(input: {
    projectId: string;
    status?: string;
    limit: number;
  }): Promise<KnowledgeIngestRecord[]>;
  updateKnowledgeStatus(
    projectId: string,
    entryId: string,
    status: string
  ): Promise<KnowledgeIngestRecord | null>;
}
