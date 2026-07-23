import { createHash } from "node:crypto";
import {
  AgentProfileIdSchema,
  OperationIdSchema,
  WorkspaceIdSchema,
  type AgentProfileId,
  type OperationId,
  type WorkspaceId,
} from "@hunter/domain";
import { z } from "zod";

export const CURSOR_TASK_PACK_LIMITS = Object.freeze({
  maxPromptBytes: 16 * 1024,
});

const TaskPackInputSchema = z.strictObject({
  operationId: OperationIdSchema,
  profileId: AgentProfileIdSchema,
  workspaceId: WorkspaceIdSchema,
  prompt: z.string(),
});

const TaskPackSchema = z.strictObject({
  schemaVersion: z.literal(1),
  relativePath: z
    .string()
    .regex(/^\.hunter\/handoffs\/opn_[a-z0-9][a-z0-9_-]{7,63}\.md$/u),
  content: z.string().min(1),
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/u),
});

export interface CursorTaskPackInput {
  readonly operationId: OperationId;
  readonly profileId: AgentProfileId;
  readonly workspaceId: WorkspaceId;
  readonly prompt: string;
}

export type CursorTaskPack = z.infer<typeof TaskPackSchema>;

function parsePrompt(value: string): string {
  if (value.trim() === "") {
    throw new Error("CURSOR_TASK_PACK_INPUT_INVALID");
  }
  if (
    Buffer.byteLength(value, "utf8") >
    CURSOR_TASK_PACK_LIMITS.maxPromptBytes
  ) {
    throw new Error("CURSOR_TASK_PACK_INPUT_TOO_LARGE");
  }
  if (
    [...value].some((character) => {
      const code = character.codePointAt(0);
      return (
        code !== undefined &&
        ((code <= 31 && code !== 9 && code !== 10) || code === 127)
      );
    })
  ) {
    throw new Error("CURSOR_TASK_PACK_INPUT_UNSAFE");
  }
  return value;
}

function parseInput(value: CursorTaskPackInput): z.infer<
  typeof TaskPackInputSchema
> {
  let parsed: z.ZodSafeParseResult<z.infer<typeof TaskPackInputSchema>>;
  try {
    parsed = TaskPackInputSchema.safeParse(value);
  } catch {
    throw new Error("CURSOR_TASK_PACK_INPUT_INVALID");
  }
  if (!parsed.success) throw new Error("CURSOR_TASK_PACK_INPUT_INVALID");
  return parsed.data;
}

export function renderTaskPack(value: CursorTaskPackInput): CursorTaskPack {
  const input = parseInput(value);
  const prompt = parsePrompt(input.prompt);
  const relativePath = `.hunter/handoffs/${input.operationId}.md`;
  const content = [
    "# Hunter Cursor Task Handoff",
    "",
    "Schema: hunter.cursor.task_pack/v1",
    `Operation: ${input.operationId}`,
    `Agent profile: ${input.profileId}`,
    `Workspace: ${input.workspaceId}`,
    "",
    "## Instruction",
    "",
    `Instruction JSON: ${JSON.stringify(prompt)}`,
    "",
    "## Completion",
    "",
    "Return to Hunter with a manual completion declaration.",
    "Manual declaration must be followed by Hunter verifier.",
    "",
  ].join("\n");
  const contentDigest = createHash("sha256")
    .update(content, "utf8")
    .digest("hex");
  return Object.freeze(
    TaskPackSchema.parse({
      schemaVersion: 1,
      relativePath,
      content,
      contentDigest,
    }),
  );
}
