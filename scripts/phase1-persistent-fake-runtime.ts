import { DatabaseSync } from "node:sqlite";

import {
  ExternalOperationReceiptSchema,
  ExternalOperationSchema,
  fingerprintExternalOperation,
  type ExternalOperation,
  type ExternalOperationHandler,
  type ExternalOperationReceipt,
} from "@hunter/runtime-contracts";
import { FakeRuntime, type FakeRuntimeOptions } from "@hunter/testkit";

interface EffectRow {
  readonly operation_json: string;
  readonly fingerprint: string;
  readonly receipt_json: string;
}

export class PersistentFakeRuntime implements ExternalOperationHandler {
  readonly #database: DatabaseSync;
  readonly #fake: FakeRuntime;
  #closed = false;

  public constructor(
    path: string,
    options: FakeRuntimeOptions,
  ) {
    this.#database = new DatabaseSync(path);
    this.#database.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS provider_effects (
        operation_id TEXT PRIMARY KEY,
        operation_json TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        invocation_count INTEGER NOT NULL CHECK(invocation_count > 0)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS restart_probes (
        sequence INTEGER PRIMARY KEY CHECK(sequence > 0),
        observed_at TEXT NOT NULL
      ) STRICT;
    `);
    this.#fake = new FakeRuntime(options);
  }

  public async execute(
    input: ExternalOperation,
  ): Promise<ExternalOperationReceipt> {
    const operation = ExternalOperationSchema.parse(input);
    if (fingerprintExternalOperation(operation) !== operation.fingerprint) {
      throw new Error("OPERATION_FINGERPRINT_MISMATCH");
    }
    const operationJson = JSON.stringify(operation);
    const existing = this.#database.prepare(
      `SELECT operation_json, fingerprint, receipt_json
         FROM provider_effects
        WHERE operation_id = ?`,
    ).get(operation.operationId) as EffectRow | undefined;
    if (existing !== undefined) {
      if (
        existing.operation_json !== operationJson
        || existing.fingerprint !== operation.fingerprint
      ) {
        throw new Error("OPERATION_ID_REUSED_WITH_DIFFERENT_PAYLOAD");
      }
      this.#database.prepare(
        `UPDATE provider_effects
            SET invocation_count = invocation_count + 1
          WHERE operation_id = ?`,
      ).run(operation.operationId);
      return ExternalOperationReceiptSchema.parse(
        JSON.parse(existing.receipt_json) as unknown,
      );
    }

    const receipt = await this.#fake.execute(operation);
    this.#database.prepare(
      `INSERT INTO provider_effects(
         operation_id, operation_json, fingerprint, receipt_json,
         invocation_count
       ) VALUES (?, ?, ?, ?, 1)`,
    ).run(
      operation.operationId,
      operationJson,
      operation.fingerprint,
      JSON.stringify(receipt),
    );
    return receipt;
  }

  public async inspect(
    input: ExternalOperation,
  ): Promise<ExternalOperationReceipt | null> {
    const operation = ExternalOperationSchema.parse(input);
    if (fingerprintExternalOperation(operation) !== operation.fingerprint) {
      throw new Error("OPERATION_FINGERPRINT_MISMATCH");
    }
    const existing = this.#database.prepare(
      `SELECT operation_json, fingerprint, receipt_json
         FROM provider_effects
        WHERE operation_id = ?`,
    ).get(operation.operationId) as EffectRow | undefined;
    if (existing === undefined) return null;
    if (
      existing.operation_json !== JSON.stringify(operation)
      || existing.fingerprint !== operation.fingerprint
    ) {
      throw new Error("OPERATION_ID_REUSED_WITH_DIFFERENT_PAYLOAD");
    }
    return ExternalOperationReceiptSchema.parse(
      JSON.parse(existing.receipt_json) as unknown,
    );
  }

  public get providerInvocationCount(): number {
    return (
      this.#database.prepare(
        "SELECT COALESCE(SUM(invocation_count), 0) AS count FROM provider_effects",
      ).get() as { readonly count: number }
    ).count;
  }

  public get providerNativeEffectCount(): number {
    return (
      this.#database.prepare(
        "SELECT COUNT(*) AS count FROM provider_effects",
      ).get() as { readonly count: number }
    ).count;
  }

  public operationIds(): readonly string[] {
    return (
      this.#database.prepare(
        "SELECT operation_id FROM provider_effects ORDER BY operation_id",
      ).all() as unknown as readonly { readonly operation_id: string }[]
    ).map(({ operation_id }) => operation_id);
  }

  public recordRestartProbe(sequence: number, observedAt: string): void {
    if (!Number.isSafeInteger(sequence) || sequence <= 0) {
      throw new Error("RESTART_PROBE_SEQUENCE_INVALID");
    }
    if (Number.isNaN(Date.parse(observedAt))) {
      throw new Error("RESTART_PROBE_TIME_INVALID");
    }
    const existing = this.#database.prepare(
      "SELECT observed_at FROM restart_probes WHERE sequence = ?",
    ).get(sequence) as { readonly observed_at: string } | undefined;
    if (existing !== undefined) {
      if (existing.observed_at !== observedAt) {
        throw new Error("RESTART_PROBE_ID_REUSED");
      }
      return;
    }
    this.#database.prepare(
      "INSERT INTO restart_probes(sequence, observed_at) VALUES (?, ?)",
    ).run(sequence, observedAt);
  }

  public get restartProbeCount(): number {
    return (
      this.#database.prepare(
        "SELECT COUNT(*) AS count FROM restart_probes",
      ).get() as { readonly count: number }
    ).count;
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#database.close();
  }
}
