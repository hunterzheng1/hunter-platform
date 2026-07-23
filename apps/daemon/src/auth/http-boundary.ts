import { z } from "zod";

import { LocalCapabilitySchema } from "./local-capability.js";

export const DaemonReadinessRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("hunterd-ready"),
  port: z.number().int().min(1).max(65_535),
});
export type DaemonReadinessRecord = z.infer<typeof DaemonReadinessRecordSchema>;

export async function readDaemonBootstrapCapability(
  input: AsyncIterable<Uint8Array | string>,
): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const encoded = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    size += encoded.byteLength;
    if (size > 128) throw new Error("DAEMON_BOOTSTRAP_INVALID");
    chunks.push(encoded);
  }
  const line = Buffer.concat(chunks).toString("utf8");
  const match = /^([A-Za-z0-9_-]{43})\r?\n$/u.exec(line);
  if (match?.[1] === undefined) throw new Error("DAEMON_BOOTSTRAP_INVALID");
  return LocalCapabilitySchema.parse(match[1]);
}

export function serializeDaemonReadiness(
  input: DaemonReadinessRecord,
): string {
  return `${JSON.stringify(DaemonReadinessRecordSchema.parse(input))}\n`;
}

export function assertProtectedLoopbackListen(options: {
  readonly host: string;
  readonly port: number;
}): void {
  if (options.host !== "127.0.0.1" || options.port !== 0) {
    throw new Error("FOUNDATION_REMOTE_LISTENER_FORBIDDEN");
  }
}
