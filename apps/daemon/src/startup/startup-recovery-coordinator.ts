import { canonicalSha256, deepFreeze } from "@hunter/domain";

export interface RecoveryFact {
  readonly kind: string;
  readonly status?: string | undefined;
  readonly [key: string]: unknown;
}

export interface RecoveryPorts {
  validateStorage(): Promise<readonly RecoveryFact[]>;
  reconcileMigration(): Promise<readonly RecoveryFact[]>;
  reconcileOutbox(): Promise<readonly RecoveryFact[]>;
  enumerateActiveAttempts(): Promise<readonly RecoveryFact[]>;
  probeExternalState(attempts: readonly RecoveryFact[]): Promise<readonly RecoveryFact[]>;
  reconcileLeasesAndWorkspace(attempts: readonly RecoveryFact[]): Promise<readonly RecoveryFact[]>;
  validateProjections(): Promise<readonly RecoveryFact[]>;
  submitRecoveryConclusions(facts: readonly RecoveryFact[]): Promise<unknown>;
}

export interface RecoveryReport {
  readonly stages: readonly { readonly name: string; readonly durationMs: number }[];
  readonly conclusions: readonly RecoveryFact[];
  readonly receipt: unknown;
  readonly fingerprint: string;
}

function conclusion(fact: RecoveryFact): RecoveryFact {
  if (fact.status === "missing" || fact.status === "drift" || fact.status === "expired") {
    return { ...fact, observedStatus: fact.status, status: "needs_attention" };
  }
  return fact;
}

export class StartupRecoveryCoordinator {
  public constructor(private readonly ports: RecoveryPorts) {}

  public async run(): Promise<RecoveryReport> {
    const stages: Array<{ name: string; durationMs: number }> = [];
    const timed = async <T>(name: string, action: () => Promise<T>): Promise<T> => {
      const started = performance.now();
      const result = await action();
      stages.push({ name, durationMs: Math.max(0, performance.now() - started) });
      return result;
    };
    const storage = await timed("storage", async () => await this.ports.validateStorage());
    const migration = await timed("migration", async () => await this.ports.reconcileMigration());
    const attempts = await timed("attempts", async () => await this.ports.enumerateActiveAttempts());
    const leases = await timed("leases", async () => await this.ports.reconcileLeasesAndWorkspace(attempts));
    const outbox = await timed("outbox", async () => await this.ports.reconcileOutbox());
    const external = await timed("external", async () => await this.ports.probeExternalState(attempts));
    const projections = await timed("projections", async () => await this.ports.validateProjections());
    const conclusions = [...storage, ...migration, ...outbox, ...external, ...leases, ...projections]
      .map(conclusion);
    const fingerprint = canonicalSha256(conclusions);
    const receipt = await timed("flow", async () => await this.ports.submitRecoveryConclusions(conclusions));
    return deepFreeze({ stages, conclusions, receipt, fingerprint });
  }
}

export async function recoverThenListen(
  coordinator: StartupRecoveryCoordinator,
  buildApp: () => Promise<{ listen(): Promise<unknown> }>,
): Promise<void> {
  await coordinator.run();
  const app = await buildApp();
  await app.listen();
}
