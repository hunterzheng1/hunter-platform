import { createHmac, timingSafeEqual } from "node:crypto";

import { canonicalJson, type PlatformInformationCursorVerifierPort } from "@hunter-harness/contracts";
import { z } from "zod";

const payloadSchema = z.object({
  schema_version: z.literal(1),
  actor_id: z.string().min(1).max(160),
  project_id: z.string().min(1).max(160),
  view: z.literal("branch_monitor"),
  sort: z.literal("last_event_at_desc_run_id_asc"),
  offset: z.number().int().nonnegative()
}).strict();
type CursorScope = Omit<z.infer<typeof payloadSchema>, "schema_version" | "offset">;

export interface BranchMonitorCursorPort extends PlatformInformationCursorVerifierPort {
  issue(input: CursorScope & { readonly offset: number }): Promise<string>;
  decode(input: CursorScope & { readonly cursor: string }): Promise<number | null>;
}

export function createBranchMonitorCursorPort(secret: string): BranchMonitorCursorPort {
  if (Buffer.byteLength(secret, "utf8") < 32) throw new Error("BRANCH_MONITOR_CURSOR_SECRET_INVALID");
  const sign = (payload: string): Buffer => createHmac("sha256", secret).update(payload, "utf8").digest();
  const decode = async (input: CursorScope & { readonly cursor: string }): Promise<number | null> => {
    if (!/^[A-Za-z0-9_-]{59,512}$/u.test(input.cursor)) return null;
    const encoded = input.cursor.slice(0, -43);
    const signature = input.cursor.slice(-43);
    let serialized: string;
    let actual: Buffer;
    try {
      serialized = Buffer.from(encoded, "base64url").toString("utf8");
      actual = Buffer.from(signature, "base64url");
      if (Buffer.from(serialized, "utf8").toString("base64url") !== encoded ||
          actual.toString("base64url") !== signature) return null;
    } catch {
      return null;
    }
    const expected = sign(serialized);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    let raw: unknown;
    try { raw = JSON.parse(serialized) as unknown; } catch { return null; }
    const parsed = payloadSchema.safeParse(raw);
    if (!parsed.success || parsed.data.actor_id !== input.actor_id ||
        parsed.data.project_id !== input.project_id || parsed.data.view !== input.view ||
        parsed.data.sort !== input.sort) return null;
    return parsed.data.offset;
  };
  return {
    async issue(input) {
      const serialized = canonicalJson({ schema_version: 1, ...input });
      return `${Buffer.from(serialized).toString("base64url")}${sign(serialized).toString("base64url")}`;
    },
    decode,
    async verify(input) {
      if (input.view !== "branch_monitor" || input.sort !== "last_event_at_desc_run_id_asc") return false;
      return await decode({
        cursor: input.cursor,
        actor_id: input.actor_id,
        project_id: input.project_id,
        view: input.view,
        sort: input.sort
      }) !== null;
    }
  };
}
