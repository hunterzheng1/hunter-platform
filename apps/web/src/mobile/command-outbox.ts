import {
  MobileCommandEnvelopeSchema,
  MobileCommandResultSchema,
  type MobileCommandEnvelope,
  type MobileCommandResult,
} from "@hunter/device-gateway/mobile-contracts";

import { openDeviceVault } from "./device-key.js";

interface CommandRecord {
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly command: MobileCommandEnvelope;
  readonly createdAt: string;
}

export type TerminalMobileCommandReceipt = MobileCommandResult;

export interface MobileCommandOutboxOptions {
  readonly indexedDB: IDBFactory;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
    transaction.oncomplete = () => resolve();
  });
}

function terminalReceipt(value: unknown): TerminalMobileCommandReceipt {
  const parsed = MobileCommandResultSchema.safeParse(value);
  if (!parsed.success) throw new Error("COMMAND_RECEIPT_INVALID");
  return parsed.data;
}

export class MobileCommandOutbox {
  public constructor(private readonly options: MobileCommandOutboxOptions) {}

  public async submit(
    candidate: unknown,
    transport: (command: MobileCommandEnvelope) => Promise<unknown>,
  ): Promise<TerminalMobileCommandReceipt> {
    const command = MobileCommandEnvelopeSchema.parse(candidate);
    await this.enqueue(command);
    return await this.retry(command.idempotencyKey, transport);
  }

  public async retry(
    idempotencyKey: string,
    transport: (command: MobileCommandEnvelope) => Promise<unknown>,
  ): Promise<TerminalMobileCommandReceipt> {
    const record = await this.get(idempotencyKey);
    if (record === undefined) throw new Error("COMMAND_OUTBOX_ENTRY_NOT_FOUND");
    const receipt = terminalReceipt(await transport(record.command));
    await this.delete(idempotencyKey);
    return receipt;
  }

  public async pending(): Promise<readonly MobileCommandEnvelope[]> {
    const database = await openDeviceVault(this.options.indexedDB);
    try {
      const transaction = database.transaction("command-outbox", "readonly");
      const records = (await requestResult(
        transaction.objectStore("command-outbox").getAll(),
      )) as CommandRecord[];
      await transactionDone(transaction);
      return records
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .map((record) => MobileCommandEnvelopeSchema.parse(record.command));
    } finally {
      database.close();
    }
  }

  private async enqueue(command: MobileCommandEnvelope): Promise<void> {
    const fingerprint = canonicalJson(command);
    const existing = await this.get(command.idempotencyKey);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) throw new Error("IDEMPOTENCY_KEY_REUSED");
      return;
    }
    const database = await openDeviceVault(this.options.indexedDB);
    try {
      const transaction = database.transaction("command-outbox", "readwrite");
      transaction.objectStore("command-outbox").add({
        idempotencyKey: command.idempotencyKey,
        fingerprint,
        command,
        createdAt: new Date().toISOString(),
      } satisfies CommandRecord);
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }

  private async get(idempotencyKey: string): Promise<CommandRecord | undefined> {
    const database = await openDeviceVault(this.options.indexedDB);
    try {
      const transaction = database.transaction("command-outbox", "readonly");
      const result = await requestResult(
        transaction.objectStore("command-outbox").get(idempotencyKey),
      );
      await transactionDone(transaction);
      return result as CommandRecord | undefined;
    } finally {
      database.close();
    }
  }

  private async delete(idempotencyKey: string): Promise<void> {
    const database = await openDeviceVault(this.options.indexedDB);
    try {
      const transaction = database.transaction("command-outbox", "readwrite");
      transaction.objectStore("command-outbox").delete(idempotencyKey);
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }
}
