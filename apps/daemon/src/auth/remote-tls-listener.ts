import type { FastifyInstance } from "fastify";

export type RemoteTlsListenerResult =
  | { readonly status: "disabled" }
  | {
      readonly status: "listening";
      readonly address: string;
      close(): Promise<void>;
    };

export type RemoteTlsListenerOptions =
  | { readonly enabled?: false }
  | {
      readonly enabled: true;
      readonly host: string;
      readonly port: number;
      readonly key: string | Buffer;
      readonly cert: string | Buffer;
      readonly buildApp: (https: {
        readonly key: string | Buffer;
        readonly cert: string | Buffer;
        readonly minVersion: "TLSv1.3";
        readonly maxVersion: "TLSv1.3";
      }) => FastifyInstance;
    };

export async function startRemoteTlsListener(
  options: RemoteTlsListenerOptions = {},
): Promise<RemoteTlsListenerResult> {
  if (options.enabled !== true) return { status: "disabled" };
  if (options.host === "127.0.0.1" || options.host === "::1" || options.host === "localhost") {
    throw new Error("REMOTE_LISTENER_REQUIRES_NON_LOOPBACK_HOST");
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
    throw new Error("REMOTE_LISTENER_PORT_INVALID");
  }
  if (
    (typeof options.key === "string" && options.key.length === 0)
    || (Buffer.isBuffer(options.key) && options.key.byteLength === 0)
    || (typeof options.cert === "string" && options.cert.length === 0)
    || (Buffer.isBuffer(options.cert) && options.cert.byteLength === 0)
  ) {
    throw new Error("REMOTE_TLS_MATERIAL_REQUIRED");
  }
  const app = options.buildApp({
    key: options.key,
    cert: options.cert,
    minVersion: "TLSv1.3",
    maxVersion: "TLSv1.3",
  });
  const address = await app.listen({ host: options.host, port: options.port });
  if (!address.startsWith("https://")) {
    await app.close();
    throw new Error("REMOTE_TLS_REQUIRED");
  }
  return {
    status: "listening",
    address,
    close: async () => await app.close(),
  };
}
