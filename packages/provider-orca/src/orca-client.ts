import { posix } from "node:path";
import { OperationIdSchema, type OperationId } from "@hunter/domain";
import { z } from "zod";
import type { JsonCommandRunner } from "./command-runner.js";

function hasNoControlCharacters(value: string): boolean {
  return [...value].every((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && codePoint > 0x1f && codePoint !== 0x7f;
  });
}

const ProviderRequestIdSchema = z.string().min(1).max(256).refine(hasNoControlCharacters);
const OrcaRepoIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)
  .refine((value) => !value.includes("::"), "ORCA_REPO_ID_INVALID")
  .brand<"OrcaRepoId">();
const OrcaTerminalIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)
  .brand<"OrcaTerminalId">();
function isFullyQualifiedWindowsPath(path: string): boolean {
  if (/^[A-Za-z]:[\\/]/u.test(path)) return true;
  if (/^\\\\\?\\[A-Za-z]:\\/u.test(path)) return true;
  if (/^\\\\\?\\UNC\\[^\\/]+\\[^\\/]+(?:\\.*)?$/iu.test(path)) return true;
  return /^\\\\(?![?.]\\)[^\\/]+\\[^\\/]+(?:\\.*)?$/u.test(path);
}

function isSupportedFullyQualifiedPath(path: string): boolean {
  return isFullyQualifiedWindowsPath(path) || posix.isAbsolute(path);
}

export const OrcaAbsolutePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(hasNoControlCharacters)
  .refine(isSupportedFullyQualifiedPath);

export const OrcaWorktreeIdSchema = z
  .string()
  .min(4)
  .max(4_096)
  .refine(hasNoControlCharacters)
  .superRefine((value, context) => {
    const separator = value.indexOf("::");
    if (
      separator <= 0 ||
      !OrcaRepoIdSchema.safeParse(value.slice(0, separator)).success ||
      !OrcaAbsolutePathSchema.safeParse(value.slice(separator + 2)).success
    ) {
      context.addIssue({ code: "custom", message: "ORCA_WORKTREE_ID_INVALID" });
    }
  })
  .brand<"OrcaWorktreeId">();

export type OrcaRepoId = z.infer<typeof OrcaRepoIdSchema>;
export type OrcaTerminalId = z.infer<typeof OrcaTerminalIdSchema>;
export type OrcaWorktreeId = z.infer<typeof OrcaWorktreeIdSchema>;
export type OrcaPathFlavor = "windows" | "posix";

export interface OrcaClientOptions {
  readonly pathFlavor?: OrcaPathFlavor;
}

const AddRepositoryResultSchema = z.strictObject({
  repo: z.strictObject({ id: OrcaRepoIdSchema }),
});
const CreateWorktreeResultSchema = z.strictObject({
  worktree: z.strictObject({ id: OrcaWorktreeIdSchema }),
  startupTerminal: z
    .strictObject({ handle: OrcaTerminalIdSchema })
    .nullable()
    .optional(),
});
const CreateTerminalResultSchema = z.strictObject({
  terminal: z.strictObject({ handle: OrcaTerminalIdSchema }),
});
const TerminalReadResultSchema = z.strictObject({
  text: z.string().max(1024 * 1024),
  nextCursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  latestCursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  limited: z.boolean(),
});

function envelope<ResultSchema extends z.ZodType>(
  result: ResultSchema,
): z.ZodObject<{
  id: typeof ProviderRequestIdSchema;
  ok: z.ZodLiteral<true>;
  result: ResultSchema;
}> {
  // Both envelope and result are strict. Unversioned transport metadata is
  // rejected so schema drift cannot become an assumed capability.
  return z.strictObject({
    id: ProviderRequestIdSchema,
    ok: z.literal(true),
    result,
  });
}

const AddRepositoryEnvelopeSchema = envelope(AddRepositoryResultSchema);
const CreateWorktreeEnvelopeSchema = envelope(CreateWorktreeResultSchema);
const CreateTerminalEnvelopeSchema = envelope(CreateTerminalResultSchema);
const TerminalReadEnvelopeSchema = envelope(TerminalReadResultSchema);

export class OrcaOutputError extends Error {
  constructor() {
    super("ORCA_OUTPUT_SCHEMA_MISMATCH");
    this.name = "OrcaOutputError";
  }
}

function parseEnvelope<Result>(
  schema: z.ZodType<{ readonly result: Result }>,
  input: unknown,
): Result {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new OrcaOutputError();
  return parsed.data.result;
}

function splitWorktreeId(
  id: OrcaWorktreeId,
  expectedRepoId: OrcaRepoId,
  pathFlavor: OrcaPathFlavor,
): { readonly worktreeId: OrcaWorktreeId; readonly reportedAbsolutePath: string } {
  const prefix = `${expectedRepoId}::`;
  if (!id.startsWith(prefix)) throw new OrcaOutputError();
  const reportedAbsolutePath = id.slice(prefix.length);
  if (!isPathForFlavor(reportedAbsolutePath, pathFlavor)) {
    throw new OrcaOutputError();
  }
  return { worktreeId: id, reportedAbsolutePath };
}

function terminalExecutableToken(input: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(input)) {
    throw new Error("ORCA_TERMINAL_EXECUTABLE_INVALID");
  }
  return input;
}

function boundedInteger(input: number, minimum: number, maximum: number, code: string): number {
  if (!Number.isSafeInteger(input) || input < minimum || input > maximum) {
    throw new Error(code);
  }
  return input;
}

function isPathForFlavor(input: string, pathFlavor: OrcaPathFlavor): boolean {
  if (!OrcaAbsolutePathSchema.safeParse(input).success) return false;
  return pathFlavor === "windows"
    ? isFullyQualifiedWindowsPath(input)
    : posix.isAbsolute(input);
}

function parseRepositoryPath(input: string, pathFlavor: OrcaPathFlavor): string {
  const parsed = OrcaAbsolutePathSchema.safeParse(input);
  if (!parsed.success || !isPathForFlavor(parsed.data, pathFlavor)) {
    throw new Error("ORCA_REPOSITORY_PATH_INVALID");
  }
  return parsed.data;
}

function parseWorktreeId(
  input: OrcaWorktreeId | string,
  pathFlavor: OrcaPathFlavor,
): OrcaWorktreeId {
  const parsed = OrcaWorktreeIdSchema.safeParse(input);
  if (!parsed.success) throw new Error("ORCA_WORKTREE_ID_INVALID");
  const separator = parsed.data.indexOf("::");
  if (!isPathForFlavor(parsed.data.slice(separator + 2), pathFlavor)) {
    throw new Error("ORCA_WORKTREE_ID_INVALID");
  }
  return parsed.data;
}

export class OrcaClient {
  readonly #pathFlavor: OrcaPathFlavor;

  constructor(
    private readonly runner: JsonCommandRunner,
    options: OrcaClientOptions = {},
  ) {
    this.#pathFlavor =
      options.pathFlavor ?? (process.platform === "win32" ? "windows" : "posix");
  }

  async addRepository(repositoryPath: string): Promise<{ readonly repoId: OrcaRepoId }> {
    const parsedRepositoryPath = parseRepositoryPath(repositoryPath, this.#pathFlavor);
    const result = parseEnvelope(
      AddRepositoryEnvelopeSchema,
      await this.runner.run(["repo", "add", "--path", parsedRepositoryPath, "--json"]),
    );
    return { repoId: result.repo.id };
  }

  async createWorktree(
    repoIdInput: OrcaRepoId | string,
    operationIdInput: OperationId,
  ): Promise<{
    readonly worktreeId: OrcaWorktreeId;
    readonly reportedAbsolutePath: string;
  }> {
    const repoId = OrcaRepoIdSchema.parse(repoIdInput);
    const operationId = OperationIdSchema.parse(operationIdInput);
    const result = parseEnvelope(
      CreateWorktreeEnvelopeSchema,
      await this.runner.run([
        "worktree",
        "create",
        "--repo",
        `id:${repoId}`,
        "--name",
        `hunter-${operationId}`,
        "--setup",
        "skip",
        "--no-parent",
        "--json",
      ]),
    );
    return splitWorktreeId(result.worktree.id, repoId, this.#pathFlavor);
  }

  async createTerminal(
    worktreeIdInput: OrcaWorktreeId | string,
    executableInput: string,
  ): Promise<{ readonly terminalId: OrcaTerminalId }> {
    const worktreeId = parseWorktreeId(worktreeIdInput, this.#pathFlavor);
    const executable = terminalExecutableToken(executableInput);
    const result = parseEnvelope(
      CreateTerminalEnvelopeSchema,
      await this.runner.run([
        "terminal",
        "create",
        "--worktree",
        `id:${worktreeId}`,
        "--title",
        "hunter-managed",
        "--command",
        executable,
        "--json",
      ]),
    );
    return { terminalId: result.terminal.handle };
  }

  async readTerminal(
    terminalIdInput: OrcaTerminalId | string,
    cursorInput: number,
    limitInput: number,
  ): Promise<z.infer<typeof TerminalReadResultSchema>> {
    const terminalId = OrcaTerminalIdSchema.parse(terminalIdInput);
    const cursor = boundedInteger(cursorInput, 0, Number.MAX_SAFE_INTEGER, "ORCA_CURSOR_INVALID");
    const limit = boundedInteger(limitInput, 1, 1_000, "ORCA_LIMIT_INVALID");
    const result = parseEnvelope(
      TerminalReadEnvelopeSchema,
      await this.runner.run([
        "terminal",
        "read",
        "--terminal",
        terminalId,
        "--cursor",
        String(cursor),
        "--limit",
        String(limit),
        "--json",
      ]),
    );
    if (
      result.nextCursor > result.latestCursor ||
      result.nextCursor < cursor ||
      result.latestCursor < cursor
    ) {
      throw new OrcaOutputError();
    }
    return result;
  }
}
