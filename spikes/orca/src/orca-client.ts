import { z } from "zod";
import type {
  CommandResult,
  CommandRunner,
} from "@hunter/spike-testkit";

const JsonRecordSchema = z.record(z.string(), z.unknown());

const OrcaStatusEnvelopeSchema = z.object({
  id: z.string().min(1),
  ok: z.literal(true),
  result: z.object({
    app: z.object({
      running: z.boolean(),
      pid: z.number().int().nonnegative(),
      desktopWindowStatus: z.string().min(1),
    }),
    runtime: z.object({
      state: z.string().min(1),
      reachable: z.boolean(),
      runtimeId: z.string().min(1),
    }),
    graph: z.object({
      state: z.string().min(1),
    }),
  }),
});

const OrcaAddRepoEnvelopeSchema = z.object({
  id: z.string().min(1),
  ok: z.literal(true),
  result: z.object({
    repo: z.object({
      id: z.string().min(1),
    }),
  }),
});

const OrcaCreateWorktreeEnvelopeSchema = z.object({
  id: z.string().min(1),
  ok: z.literal(true),
  result: z.object({
    worktree: z.object({
      id: z.string().min(1),
    }),
    startupTerminal: z
      .object({
        handle: z.string().min(1),
      })
      .nullable()
      .optional(),
  }),
});

const OrcaTerminalListEnvelopeSchema = z.object({
  id: z.string().min(1),
  ok: z.literal(true),
  result: z.object({
    terminals: z.array(
      z.object({
        handle: z.string().min(1),
      }),
    ),
  }),
});

const OrcaCreateTerminalEnvelopeSchema = z.object({
  id: z.string().min(1),
  ok: z.literal(true),
  result: z.object({
    terminal: z.object({
      handle: z.string().min(1),
    }),
  }),
});

const OrcaTerminalReadEnvelopeSchema = z.object({
  id: z.string().min(1),
  ok: z.literal(true),
  result: z.object({
    text: z.string(),
    nextCursor: z.string().min(1),
    latestCursor: z.string().min(1),
    limited: z.boolean(),
  }),
});

const OrcaGenericSuccessEnvelopeSchema = z.object({
  id: z.string().min(1),
  ok: z.literal(true),
  result: JsonRecordSchema,
});

export interface OrcaClientOptions {
  readonly runner: CommandRunner;
  readonly executable: string;
  readonly cwd: string;
  readonly timeoutMs: number;
}

export interface OrcaJsonReceipt<Known> {
  readonly known: Known;
  readonly raw: Readonly<Record<string, unknown>>;
  readonly command: CommandResult;
}

export type OrcaStatus = z.infer<typeof OrcaStatusEnvelopeSchema>["result"];
export type OrcaRepo = z.infer<typeof OrcaAddRepoEnvelopeSchema>["result"]["repo"];
export type OrcaCreateWorktreeResult = z.infer<
  typeof OrcaCreateWorktreeEnvelopeSchema
>["result"];

export interface CreateWorktreeRequest {
  readonly repoId: string;
  readonly name: string;
  readonly agent?: string;
  readonly setup?: "run" | "skip" | "inherit";
}

export interface CreateTerminalRequest {
  readonly worktreeId: string;
  readonly title: string;
  readonly command: string;
}

export interface SendTerminalRequest {
  readonly terminalHandle: string;
  readonly text: string;
  readonly enter: boolean;
}

export interface ReadTerminalRequest {
  readonly terminalHandle: string;
  readonly cursor?: string;
  readonly limit: number;
}

export interface WaitTerminalRequest {
  readonly terminalHandle: string;
  readonly for: "exit" | "tui-idle";
  readonly timeoutMs: number;
}

export class OrcaCommandError extends Error {
  constructor(readonly result: CommandResult) {
    super("ORCA_COMMAND_FAILED");
    this.name = "OrcaCommandError";
  }
}

export class OrcaClient {
  readonly #runner: CommandRunner;
  readonly #executable: string;
  readonly #cwd: string;
  readonly #timeoutMs: number;

  constructor(options: OrcaClientOptions) {
    this.#runner = options.runner;
    this.#executable = options.executable;
    this.#cwd = options.cwd;
    this.#timeoutMs = options.timeoutMs;
  }

  async #runJson<Envelope>(
    args: readonly string[],
    schema: z.ZodType<Envelope>,
    runnerTimeoutMs: number = this.#timeoutMs,
  ): Promise<{
    readonly envelope: Envelope;
    readonly raw: Readonly<Record<string, unknown>>;
    readonly command: CommandResult;
  }> {
    const command = await this.#runner.run({
      executable: this.#executable,
      args,
      cwd: this.#cwd,
      timeoutMs: runnerTimeoutMs,
    });
    if (command.exitCode !== 0 || command.timedOut || command.spawnError != null) {
      throw new OrcaCommandError(command);
    }

    const raw = JsonRecordSchema.parse(JSON.parse(command.stdout) as unknown);
    return { envelope: schema.parse(raw), raw, command };
  }

  async status(): Promise<OrcaJsonReceipt<OrcaStatus>> {
    const { envelope, raw, command } = await this.#runJson(
      ["status", "--json"],
      OrcaStatusEnvelopeSchema,
    );
    return { known: envelope.result, raw, command };
  }

  async addRepo(path: string): Promise<OrcaJsonReceipt<OrcaRepo>> {
    const { envelope, raw, command } = await this.#runJson(
      ["repo", "add", "--path", path, "--json"],
      OrcaAddRepoEnvelopeSchema,
    );
    return { known: envelope.result.repo, raw, command };
  }

  async createWorktree(
    request: CreateWorktreeRequest,
  ): Promise<OrcaJsonReceipt<OrcaCreateWorktreeResult>> {
    const args = [
      "worktree",
      "create",
      "--repo",
      `id:${request.repoId}`,
      "--name",
      request.name,
    ];
    if (request.agent !== undefined) args.push("--agent", request.agent);
    if (request.setup !== undefined) args.push("--setup", request.setup);
    args.push("--json");

    const { envelope, raw, command } = await this.#runJson(
      args,
      OrcaCreateWorktreeEnvelopeSchema,
    );
    return { known: envelope.result, raw, command };
  }

  async listTerminals(
    worktreeId: string,
  ): Promise<OrcaJsonReceipt<z.infer<typeof OrcaTerminalListEnvelopeSchema>["result"]>> {
    const { envelope, raw, command } = await this.#runJson(
      ["terminal", "list", "--worktree", `id:${worktreeId}`, "--json"],
      OrcaTerminalListEnvelopeSchema,
    );
    return { known: envelope.result, raw, command };
  }

  async createTerminal(
    request: CreateTerminalRequest,
  ): Promise<OrcaJsonReceipt<z.infer<typeof OrcaCreateTerminalEnvelopeSchema>["result"]>> {
    const { envelope, raw, command } = await this.#runJson(
      [
        "terminal",
        "create",
        "--worktree",
        `id:${request.worktreeId}`,
        "--title",
        request.title,
        "--command",
        request.command,
        "--json",
      ],
      OrcaCreateTerminalEnvelopeSchema,
    );
    return { known: envelope.result, raw, command };
  }

  async send(
    request: SendTerminalRequest,
  ): Promise<OrcaJsonReceipt<Readonly<Record<string, unknown>>>> {
    const args = [
      "terminal",
      "send",
      "--terminal",
      request.terminalHandle,
      "--text",
      request.text,
    ];
    if (request.enter) args.push("--enter");
    args.push("--json");
    const { envelope, raw, command } = await this.#runJson(
      args,
      OrcaGenericSuccessEnvelopeSchema,
    );
    return { known: envelope.result, raw, command };
  }

  async read(
    request: ReadTerminalRequest,
  ): Promise<OrcaJsonReceipt<z.infer<typeof OrcaTerminalReadEnvelopeSchema>["result"]>> {
    const args = ["terminal", "read", "--terminal", request.terminalHandle];
    if (request.cursor !== undefined) args.push("--cursor", request.cursor);
    args.push("--limit", String(request.limit), "--json");
    const { envelope, raw, command } = await this.#runJson(
      args,
      OrcaTerminalReadEnvelopeSchema,
    );
    return { known: envelope.result, raw, command };
  }

  async wait(
    request: WaitTerminalRequest,
  ): Promise<OrcaJsonReceipt<Readonly<Record<string, unknown>>>> {
    const { envelope, raw, command } = await this.#runJson(
      [
        "terminal",
        "wait",
        "--terminal",
        request.terminalHandle,
        "--for",
        request.for,
        "--timeout-ms",
        String(request.timeoutMs),
        "--json",
      ],
      OrcaGenericSuccessEnvelopeSchema,
      request.timeoutMs + 5_000,
    );
    return { known: envelope.result, raw, command };
  }

  async closeTerminal(
    terminalHandle: string,
  ): Promise<OrcaJsonReceipt<Readonly<Record<string, unknown>>>> {
    const { envelope, raw, command } = await this.#runJson(
      ["terminal", "close", "--terminal", terminalHandle, "--json"],
      OrcaGenericSuccessEnvelopeSchema,
    );
    return { known: envelope.result, raw, command };
  }

  async removeWorktree(
    worktreeId: string,
  ): Promise<OrcaJsonReceipt<Readonly<Record<string, unknown>>>> {
    const { envelope, raw, command } = await this.#runJson(
      ["worktree", "rm", "--worktree", `id:${worktreeId}`, "--force", "--json"],
      OrcaGenericSuccessEnvelopeSchema,
    );
    return { known: envelope.result, raw, command };
  }
}
