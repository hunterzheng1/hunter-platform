import type { Pool, PoolClient } from "pg";

import {
  remoteContentUploadHttpRecordSchema,
  type RemoteContentUploadHttpRef,
  type RemoteContentUploadHttpSource,
} from "@hunter-harness/contracts";

import type { RemoteContentUploadCas } from "./ports.js";

export interface RemoteContentUploadResolver {
  resolve(input: {
    readonly source: RemoteContentUploadHttpSource;
    readonly upload_ref: RemoteContentUploadHttpRef;
    readonly purpose: "remote_archive" | "remote_sync_file";
    readonly now: string;
    readonly executor?: Pick<Pool | PoolClient, "query">;
    readonly allow_expired?: true;
  }): Promise<AsyncIterable<Uint8Array>>;
}

function fail(): never {
  throw new Error("REMOTE_CONTENT_UPLOAD_NOT_FOUND");
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { return fail(); }
}

function sameOptional(left: string | undefined, right: string | undefined): boolean {
  return left === right;
}

export function createRemoteContentUploadResolver(options: {
  readonly pool: Pick<Pool, "query">;
  readonly cas: RemoteContentUploadCas;
}): RemoteContentUploadResolver {
  return Object.freeze({
    async resolve(input: Parameters<RemoteContentUploadResolver["resolve"]>[0]) {
      const executor = input.executor ?? options.pool;
      const result = await executor.query<{
        readonly project_id: string;
        readonly branch_name: string;
        readonly actor_id: string;
        readonly state: string;
        readonly expires_at: string | Date;
        readonly record_json: unknown;
      }>(`SELECT project_id,branch_name,actor_id,state,expires_at,record_json
          FROM remote_content_uploads
         WHERE project_id=$1 AND ref_id=$2 AND content_sha256=$3 AND size_bytes=$4 AND state='stored'
         FOR SHARE`, [input.source.project_id, input.upload_ref.ref_id, input.upload_ref.sha256, input.upload_ref.size_bytes]);
      const row = result.rows[0];
      if (row === undefined || row.state !== "stored") fail();
      const recordResult = remoteContentUploadHttpRecordSchema.safeParse(parseJson(row.record_json));
      if (!recordResult.success) fail();
      const record = recordResult.data;
      if (record.source.project_id !== input.source.project_id ||
          record.source.branch_name !== input.source.branch_name ||
          record.source.actor_id !== input.source.actor_id ||
          !sameOptional(record.source.commit_sha, input.source.commit_sha) ||
          !sameOptional(record.source.client_id, input.source.client_id) ||
          !sameOptional(record.source.change_key, input.source.change_key) ||
          record.purpose !== input.purpose ||
          record.upload_ref.ref_id !== input.upload_ref.ref_id ||
          record.upload_ref.sha256 !== input.upload_ref.sha256 ||
          record.upload_ref.size_bytes !== input.upload_ref.size_bytes ||
          (input.allow_expired !== true && Date.parse(record.expires_at) <= Date.parse(input.now)) ||
          !(await options.cas.hasObject({ project_id: input.source.project_id, sha256: input.upload_ref.sha256 as `sha256:${string}`, bytes: input.upload_ref.size_bytes }))) {
        fail();
      }
      const stream = options.cas.readObject({ project_id: input.source.project_id, sha256: input.upload_ref.sha256 as `sha256:${string}`, bytes: input.upload_ref.size_bytes });
      return (async function* (): AsyncGenerator<Uint8Array> {
        for await (const chunk of stream) {
          if (!(chunk instanceof Uint8Array)) fail();
          yield new Uint8Array(chunk);
        }
      })();
    }
  });
}
