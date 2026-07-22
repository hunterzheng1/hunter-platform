import { createHash } from "node:crypto";
import type {
  CommandEvidence,
  CommandRequest,
  CommandResult,
  CommandRunner,
  EvidenceEnvelope,
  ProbeEvidence,
  ProbeStatus,
} from "@hunter/spike-testkit";
import { createEvidenceEnvelope, redact } from "@hunter/spike-testkit";

interface LoginProbe {
  readonly args: readonly string[];
  readonly method: string;
  readonly provesAuthentication?: boolean;
}

interface ToolProbeDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly category: "host" | "tool" | "agent" | "runtime";
  readonly executable: string;
  readonly availabilityArgs?: readonly string[];
  readonly versionArgs: readonly string[];
  readonly helpArgs?: readonly string[];
  readonly loginProbe?: LoginProbe;
  readonly authenticationRequired: boolean;
  readonly requireNumericVersion?: boolean;
}

const TOOL_PROBES: readonly ToolProbeDefinition[] = [
  {
    id: "node",
    displayName: "Node.js",
    category: "host",
    executable: "node",
    versionArgs: ["--version"],
    authenticationRequired: false,
  },
  {
    id: "git",
    displayName: "Git",
    category: "tool",
    executable: "git",
    versionArgs: ["--version"],
    authenticationRequired: false,
  },
  {
    id: "codex",
    displayName: "Codex",
    category: "agent",
    executable: "codex",
    versionArgs: ["--version"],
    helpArgs: ["--help"],
    loginProbe: { args: ["login", "status"], method: "codex login status" },
    authenticationRequired: true,
  },
  {
    id: "codebuddy",
    displayName: "CodeBuddy Code",
    category: "agent",
    executable: "codebuddy",
    versionArgs: ["--version"],
    helpArgs: ["--help"],
    loginProbe: { args: ["auth", "status"], method: "codebuddy auth status" },
    authenticationRequired: true,
  },
  {
    id: "cursor",
    displayName: "Cursor",
    category: "agent",
    executable: "cursor",
    versionArgs: ["--version"],
    helpArgs: ["--help"],
    authenticationRequired: true,
  },
  {
    id: "orca",
    displayName: "Orca",
    category: "runtime",
    executable: "orca",
    availabilityArgs: ["status", "--json"],
    versionArgs: ["--version"],
    helpArgs: ["--help"],
    loginProbe: {
      args: ["status", "--json"],
      method: "orca status --json",
      provesAuthentication: false,
    },
    authenticationRequired: true,
    requireNumericVersion: true,
  },
  {
    id: "agent_orchestrator",
    displayName: "Agent Orchestrator fallback runtime",
    category: "runtime",
    executable: "agent-orchestrator",
    versionArgs: ["--version"],
    helpArgs: ["--help"],
    authenticationRequired: true,
  },
];

export interface DoctorInventoryOptions {
  readonly runner: CommandRunner;
  readonly cwd: string;
  readonly now: () => Date;
  readonly host: {
    readonly platform: NodeJS.Platform | string;
    readonly architecture: string;
    readonly release: string;
  };
  readonly executableOverrides?: Readonly<Record<string, string>>;
}

function commandEvidence(result: CommandResult): CommandEvidence {
  const excerpt = (value: string): string =>
    redact(value)
      .split(/\r?\n/u)
      .slice(0, 40)
      .join("\n")
      .trim();

  return {
    command: {
      executable: redact(result.executable),
      args: result.args.map((argument) => redact(argument)),
    },
    cwdScope: "repository",
    exitCode: result.exitCode,
    stdout: excerpt(result.stdout),
    stderr: excerpt(result.stderr),
    timedOut: result.timedOut,
    spawnError: result.spawnError === undefined ? null : result.spawnError,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
  };
}

async function run(
  runner: CommandRunner,
  cwd: string,
  executable: string,
  args: readonly string[],
): Promise<CommandResult> {
  const request: CommandRequest = { executable, args, cwd, timeoutMs: 5_000 };
  return await runner.run(request);
}

function firstOutputLine(result: CommandResult): string | null {
  const line = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/u)
    .map((item) => item.trim())
    .find(Boolean);
  return line === undefined ? null : redact(line);
}

function detectedVersion(
  definition: ToolProbeDefinition,
  result: CommandResult,
): string | null {
  const line = firstOutputLine(result);
  if (line === null || definition.requireNumericVersion !== true) return line;
  return /\bv?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/u.test(line) ? line : null;
}

function authenticationStatus(result: CommandResult): ProbeStatus {
  const output = `${result.stdout}\n${result.stderr}`;
  if (/not\s+logged\s+in|login\s+required|not\s+authenticated|unauthenticated/iu.test(output)) {
    return "BLOCKED";
  }
  if (result.timedOut || result.spawnError !== null && result.spawnError !== undefined) {
    return "NOT_PROVEN";
  }
  return result.exitCode === 0 ? "DETECTED" : "NOT_PROVEN";
}

function overallStatus(availability: ProbeStatus, authentication: ProbeStatus): ProbeStatus {
  if (availability === "BLOCKED" || authentication === "BLOCKED") return "BLOCKED";
  if (availability === "NOT_PROVEN" || authentication === "NOT_PROVEN") return "NOT_PROVEN";
  return "DETECTED";
}

async function probeTool(
  definition: ToolProbeDefinition,
  options: DoctorInventoryOptions,
): Promise<ProbeEvidence> {
  const versionResult = await run(
    options.runner,
    options.cwd,
    definition.executable,
    definition.versionArgs,
  );
  const commands: CommandEvidence[] = [commandEvidence(versionResult)];
  const availabilityResult =
    definition.availabilityArgs === undefined
      ? versionResult
      : await run(
          options.runner,
          options.cwd,
          definition.executable,
          definition.availabilityArgs,
        );
  if (availabilityResult !== versionResult) {
    commands.push(commandEvidence(availabilityResult));
  }
  const availability: ProbeStatus =
    availabilityResult.exitCode === 0 &&
    !availabilityResult.timedOut &&
    availabilityResult.spawnError == null
      ? "DETECTED"
      : "BLOCKED";
  let helpHash: string | null = null;

  if (availability === "DETECTED" && definition.helpArgs !== undefined) {
    const helpResult = await run(
      options.runner,
      options.cwd,
      definition.executable,
      definition.helpArgs,
    );
    commands.push(commandEvidence(helpResult));
    if (helpResult.exitCode === 0) {
      helpHash = createHash("sha256").update(redact(helpResult.stdout + helpResult.stderr)).digest("hex");
    }
  }

  let authentication: ProbeEvidence["authentication"];
  if (!definition.authenticationRequired) {
    authentication = {
      required: false,
      status: "DETECTED",
      method: "not_applicable",
      reason: "authentication_not_required",
    };
  } else if (availability === "BLOCKED") {
    authentication = {
      required: true,
      status: "BLOCKED",
      method: definition.loginProbe?.method ?? "no_safe_noninteractive_probe",
      reason: "executable_not_available",
    };
  } else if (definition.loginProbe === undefined) {
    authentication = {
      required: true,
      status: "NOT_PROVEN",
      method: "no_safe_noninteractive_probe",
      reason: "login_state_not_proven",
    };
  } else {
    const loginResult =
      definition.availabilityArgs !== undefined &&
      definition.loginProbe.args.join("\u0000") === definition.availabilityArgs.join("\u0000")
        ? availabilityResult
        : await run(
            options.runner,
            options.cwd,
            definition.executable,
            definition.loginProbe.args,
          );
    if (loginResult !== availabilityResult) {
      commands.push(commandEvidence(loginResult));
    }
    const observedStatus = authenticationStatus(loginResult);
    const status =
      observedStatus === "DETECTED" && definition.loginProbe.provesAuthentication === false
        ? "NOT_PROVEN"
        : observedStatus;
    authentication = {
      required: true,
      status,
      method: definition.loginProbe.method,
      reason:
        observedStatus === "DETECTED" && definition.loginProbe.provesAuthentication === false
          ? "runtime_status_available_login_not_proven"
          : status === "DETECTED"
          ? "login_available"
          : status === "BLOCKED"
            ? "login_missing"
            : "login_state_not_proven",
    };
  }

  return {
    id: definition.id,
    displayName: definition.displayName,
    category: definition.category,
    status: overallStatus(availability, authentication.status),
    version:
      versionResult.exitCode === 0 &&
      !versionResult.timedOut &&
      versionResult.spawnError == null
        ? detectedVersion(definition, versionResult)
        : null,
    helpHash,
    availability: {
      status: availability,
      reason: availability === "DETECTED" ? "executable_detected" : "executable_missing_or_unusable",
    },
    authentication,
    commands,
  };
}

export function finalizeTimeboxedStatus(status: ProbeStatus): ProbeStatus {
  return status === "BLOCKED" ? "NOT_PROVEN" : status;
}

export async function createDoctorInventory(
  options: DoctorInventoryOptions,
): Promise<EvidenceEnvelope> {
  const windowsStatus: ProbeStatus = options.host.platform === "win32" ? "DETECTED" : "NOT_PROVEN";
  const windowsProbe: ProbeEvidence = {
    id: "windows",
    displayName: "Windows host",
    category: "host",
    status: windowsStatus,
    version: options.host.platform === "win32" ? options.host.release : null,
    helpHash: null,
    availability: {
      status: windowsStatus,
      reason: windowsStatus === "DETECTED" ? "windows_host_detected" : "windows_host_not_observed",
    },
    authentication: {
      required: false,
      status: "DETECTED",
      method: "not_applicable",
      reason: "authentication_not_required",
    },
    commands: [],
  };
  const toolProbes = await Promise.all(
    TOOL_PROBES.map(async (definition) =>
      await probeTool(
        {
          ...definition,
          executable: options.executableOverrides?.[definition.id] ?? definition.executable,
        },
        options,
      ),
    ),
  );

  return createEvidenceEnvelope({
    evidenceType: "phase0_environment_inventory",
    generatedAt: options.now().toISOString(),
    host: options.host,
    probes: [windowsProbe, ...toolProbes],
  });
}
