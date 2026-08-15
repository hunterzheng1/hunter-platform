import type { RemoteContentUploadHttpRequestDescriptor, RemoteContentUploadHttpResult, RemoteContentUploadHttpStatus, RemoteContentUploadHttpStatusDescriptor } from "@hunter-harness/contracts";

export interface RemoteContentUploadChunk { readonly sequence: number; readonly offset: number; readonly size: number; readonly chunk_hash: `sha256:${string}`; readonly final: boolean; readonly bytes: Uint8Array; }
export interface RemoteContentUploadHttpServicePort {
  stage(input: { readonly descriptor: RemoteContentUploadHttpRequestDescriptor; readonly chunks: AsyncIterable<RemoteContentUploadChunk>; readonly signal?: AbortSignal }): Promise<RemoteContentUploadHttpResult>;
  status(input: { readonly descriptor: RemoteContentUploadHttpStatusDescriptor; readonly signal?: AbortSignal }): Promise<RemoteContentUploadHttpStatus>;
}
