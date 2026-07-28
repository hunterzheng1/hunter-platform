import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";
import {
  HerdrAdapterError,
  type HerdrCommandRunner,
} from "./command-runner.js";

const SafeStringSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (value) =>
      [...value].every((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint !== undefined && codePoint > 0x1f && codePoint !== 0x7f;
      }),
  );
const HerdrWorkspaceIdSchema = z.string().regex(/^w[1-9][0-9]*$/u);
const AgentStatusSchema = z.enum([
  "idle",
  "working",
  "blocked",
  "done",
  "unknown",
]);
const NullableSafeStringSchema = SafeStringSchema.nullable();

const WorkspaceWorktreeInfoSchema = z.strictObject({
  repo_key: SafeStringSchema,
  repo_name: SafeStringSchema,
  repo_root: SafeStringSchema,
  checkout_path: SafeStringSchema,
  is_linked_worktree: z.boolean(),
});
const WorkspaceInfoSchema = z.strictObject({
  workspace_id: HerdrWorkspaceIdSchema,
  number: z.number().int().positive(),
  label: SafeStringSchema,
  focused: z.boolean(),
  pane_count: z.number().int().nonnegative(),
  tab_count: z.number().int().nonnegative(),
  active_tab_id: SafeStringSchema,
  agent_status: AgentStatusSchema,
  tokens: z.record(z.string(), z.unknown()).optional(),
  worktree: WorkspaceWorktreeInfoSchema.nullable().optional(),
});
const TabInfoSchema = z.strictObject({
  tab_id: SafeStringSchema,
  workspace_id: HerdrWorkspaceIdSchema,
  number: z.number().int().positive(),
  label: SafeStringSchema,
  focused: z.boolean(),
  pane_count: z.number().int().nonnegative(),
  agent_status: AgentStatusSchema,
});
const PaneInfoSchema = z.strictObject({
  pane_id: SafeStringSchema,
  terminal_id: SafeStringSchema,
  workspace_id: HerdrWorkspaceIdSchema,
  tab_id: SafeStringSchema,
  focused: z.boolean(),
  agent_status: AgentStatusSchema,
  revision: z.number().int().nonnegative(),
  agent: NullableSafeStringSchema.optional(),
  agent_session: z.unknown().optional(),
  cwd: NullableSafeStringSchema.optional(),
  display_agent: NullableSafeStringSchema.optional(),
  foreground_cwd: NullableSafeStringSchema.optional(),
  label: NullableSafeStringSchema.optional(),
  scroll: z.unknown().optional(),
  state_labels: z.record(z.string(), z.unknown()).optional(),
  terminal_title: NullableSafeStringSchema.optional(),
  terminal_title_stripped: NullableSafeStringSchema.optional(),
  title: NullableSafeStringSchema.optional(),
  tokens: z.record(z.string(), z.unknown()).optional(),
});
const WorktreeInfoSchema = z.strictObject({
  path: SafeStringSchema,
  branch: NullableSafeStringSchema.optional(),
  is_bare: z.boolean(),
  is_detached: z.boolean(),
  is_prunable: z.boolean(),
  is_linked_worktree: z.boolean(),
  label: SafeStringSchema,
  open_workspace_id: HerdrWorkspaceIdSchema.nullable().optional(),
});

export const HerdrWorktreeOpenedEnvelopeSchema = z
  .strictObject({
    id: z.literal("cli:worktree:open"),
    result: z.strictObject({
      type: z.literal("worktree_opened"),
      workspace: WorkspaceInfoSchema,
      tab: TabInfoSchema,
      root_pane: PaneInfoSchema,
      worktree: WorktreeInfoSchema,
      already_open: z.boolean(),
    }),
  })
  .superRefine((envelope, context) => {
    const { result } = envelope;
    if (
      result.workspace.workspace_id !== result.tab.workspace_id
      || result.workspace.workspace_id !== result.root_pane.workspace_id
      || result.workspace.workspace_id !== result.worktree.open_workspace_id
      || result.workspace.worktree?.checkout_path !== result.worktree.path
      || result.workspace.worktree?.is_linked_worktree !== true
      || !result.worktree.is_linked_worktree
      || result.worktree.is_bare
      || result.worktree.is_detached
      || result.worktree.is_prunable
    ) {
      context.addIssue({
        code: "custom",
        path: ["result"],
        message: "HERDR_WORKTREE_RESPONSE_INCONSISTENT",
      });
    }
  });

export const HerdrWorkspaceClosedEnvelopeSchema = z.strictObject({
  id: z.literal("cli:workspace:close"),
  result: z.strictObject({ type: z.literal("ok") }),
});

const SessionInfoSchema = z.strictObject({
  name: SafeStringSchema,
  default: z.boolean(),
  running: z.boolean(),
  socket_path: SafeStringSchema,
  session_dir: SafeStringSchema,
});
const SessionListSchema = z.strictObject({
  sessions: z.array(SessionInfoSchema).max(256),
});
const SessionStoppedSchema = z.strictObject({
  stopped: z.literal(true),
  session: SessionInfoSchema,
});
const SessionDeletedSchema = z.strictObject({
  deleted: z.literal(true),
  session: SessionInfoSchema,
});

function parseOrThrow<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
  effectPossible = false,
): z.output<Schema> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new HerdrAdapterError("HERDR_OUTPUT_INVALID", effectPossible);
  }
  return parsed.data;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export interface HerdrWorktreeOpenInput {
  readonly path: string;
  readonly operationLabel: string;
}

export interface HerdrWorktreeOpenReceipt {
  readonly workspaceId: string;
  readonly reportedPath: string;
  readonly alreadyOpen: boolean;
}

export interface HerdrSessionInventory {
  readonly totalCount: number;
  readonly unrelatedCount: number;
  readonly unrelatedDigest: string;
  readonly target: "absent" | "running" | "stopped";
}

export interface HerdrOwnedSessionCleanupReceipt {
  readonly outcome: "stopped" | "deleted";
}

export class HerdrPublicClient {
  constructor(private readonly runner: HerdrCommandRunner) {}

  async openExistingWorktree(
    input: HerdrWorktreeOpenInput,
  ): Promise<HerdrWorktreeOpenReceipt> {
    if (
      !isAbsolute(input.path)
      || !/^hunter-opn_[a-z0-9][a-z0-9_-]{7,91}$/u.test(
        input.operationLabel,
      )
    ) {
      throw new HerdrAdapterError("HERDR_ARGUMENT_INVALID");
    }
    const envelope = parseOrThrow(
      HerdrWorktreeOpenedEnvelopeSchema,
      await this.runner.run([
        "worktree",
        "open",
        "--path",
        input.path,
        "--label",
        input.operationLabel,
        "--no-focus",
        "--json",
      ]),
      true,
    );
    if (envelope.result.workspace.label !== input.operationLabel) {
      throw new HerdrAdapterError("HERDR_OUTPUT_INVALID", true);
    }
    return {
      workspaceId: envelope.result.workspace.workspace_id,
      reportedPath: envelope.result.worktree.path,
      alreadyOpen: envelope.result.already_open,
    };
  }

  async closeWorkspace(workspaceId: string): Promise<void> {
    const parsedWorkspaceId = HerdrWorkspaceIdSchema.safeParse(workspaceId);
    if (!parsedWorkspaceId.success) {
      throw new HerdrAdapterError("HERDR_ARGUMENT_INVALID");
    }
    parseOrThrow(
      HerdrWorkspaceClosedEnvelopeSchema,
      await this.runner.run([
        "workspace",
        "close",
        parsedWorkspaceId.data,
      ]),
      true,
    );
  }

  async inventorySessions(targetName: string): Promise<HerdrSessionInventory> {
    if (!/^hunter-[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(targetName)) {
      throw new HerdrAdapterError("HERDR_ARGUMENT_INVALID");
    }
    const parsed = parseOrThrow(
      SessionListSchema,
      await this.runner.run(["session", "list", "--json"]),
    );
    const targets = parsed.sessions.filter(({ name }) => name === targetName);
    if (targets.length > 1) {
      throw new HerdrAdapterError("HERDR_OUTPUT_INVALID");
    }
    const unrelated = parsed.sessions
      .filter(({ name }) => name !== targetName)
      .sort((left, right) => left.name.localeCompare(right.name));
    return {
      totalCount: parsed.sessions.length,
      unrelatedCount: unrelated.length,
      unrelatedDigest: createHash("sha256")
        .update(JSON.stringify(canonicalize(unrelated)))
        .digest("hex"),
      target:
        targets.length === 0
          ? "absent"
          : targets[0]!.running
            ? "running"
            : "stopped",
    };
  }

  async stopOwnedSession(
    targetName: string,
  ): Promise<HerdrOwnedSessionCleanupReceipt> {
    if (!/^hunter-[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(targetName)) {
      throw new HerdrAdapterError("HERDR_ARGUMENT_INVALID");
    }
    const parsed = parseOrThrow(
      SessionStoppedSchema,
      await this.runner.run([
        "session",
        "stop",
        targetName,
        "--json",
      ]),
      true,
    );
    if (
      parsed.session.name !== targetName
      || parsed.session.default
      || parsed.session.running
    ) {
      throw new HerdrAdapterError("HERDR_OUTPUT_INVALID", true);
    }
    return { outcome: "stopped" };
  }

  async deleteOwnedSession(
    targetName: string,
  ): Promise<HerdrOwnedSessionCleanupReceipt> {
    if (!/^hunter-[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(targetName)) {
      throw new HerdrAdapterError("HERDR_ARGUMENT_INVALID");
    }
    const parsed = parseOrThrow(
      SessionDeletedSchema,
      await this.runner.run([
        "session",
        "delete",
        targetName,
        "--json",
      ]),
      true,
    );
    if (
      parsed.session.name !== targetName
      || parsed.session.default
      || parsed.session.running
    ) {
      throw new HerdrAdapterError("HERDR_OUTPUT_INVALID", true);
    }
    return { outcome: "deleted" };
  }
}
