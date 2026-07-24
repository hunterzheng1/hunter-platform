import { isAbsolute, join, resolve } from "node:path";

import { LeaseOwnerIdSchema } from "@hunter/domain";
import type { ExternalOperationReceipt } from "@hunter/runtime-contracts";

import {
  readDaemonBootstrapCapability,
  serializeDaemonReadiness,
} from "./auth/http-boundary.js";
import { startDaemon } from "./main.js";
import type { CompletionVerifierPort } from "./services/application-services.js";

const DATA_DIRECTORY_ENVIRONMENT_KEY = "HUNTER_DESKTOP_DATA_DIRECTORY";
const DESKTOP_SECRET_REF = "os-credential://hunter/desktop-bootstrap";

function desktopDataDirectory(): string {
  const input = process.env[DATA_DIRECTORY_ENVIRONMENT_KEY];
  if (
    input === undefined
    || input.trim() === ""
    || !isAbsolute(input)
    || resolve(input) !== input
  ) {
    throw new Error("DESKTOP_DATA_DIRECTORY_INVALID");
  }
  return input;
}

const unavailableRuntime = {
  async execute(): Promise<ExternalOperationReceipt> {
    throw new Error("PRODUCTION_RUNTIME_NOT_CONFIGURED");
  },
};

const unavailableVerifier: CompletionVerifierPort = {
  async verify() {
    throw new Error("PRODUCTION_VERIFIER_NOT_CONFIGURED");
  },
};

async function bootstrap(): Promise<void> {
  const bootstrapArguments = process.argv.slice(2);
  if (
    bootstrapArguments.length !== 2
    || bootstrapArguments[0] !== "--port=0"
    || bootstrapArguments[1] !== "--bootstrap-stdin"
  ) {
    process.stderr.write("hunterd bootstrap arguments invalid\n");
    process.exitCode = 1;
    return;
  }
  try {
    const capability = await readDaemonBootstrapCapability(process.stdin);
    const dataDirectory = desktopDataDirectory();
    const daemon = await startDaemon({
      dataDirectory,
      secretRef: DESKTOP_SECRET_REF,
      secretStore: {
        resolveSecret: async (secretRef) => {
          if (secretRef !== DESKTOP_SECRET_REF) {
            throw new Error("DESKTOP_SECRET_REF_INVALID");
          }
          return capability;
        },
      },
      externalHandler: unavailableRuntime,
      verifier: unavailableVerifier,
      archive: {
        root: join(dataDirectory, "archives"),
        source: {
          async build() {
            throw new Error("PRODUCTION_ARCHIVE_SOURCE_NOT_CONFIGURED");
          },
        },
        ownerId: LeaseOwnerIdSchema.parse("own_desktop_archive"),
      },
      allowedOrigin: "app://hunter",
      localCapability: {
        capability,
        principal: {
          principalId: "desktop",
          authorizedProjectIds: [],
          expiresAt: "9999-12-31T23:59:59.999Z",
          csrf: "local-capability",
          sessionId: "0".repeat(32),
        },
      },
      publishPort: async (port) => {
        process.stdout.write(serializeDaemonReadiness({
          schemaVersion: 1,
          kind: "hunterd-ready",
          port,
        }));
      },
    });
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      void daemon.shutdown().finally(() => {
        process.exitCode = 0;
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch {
    process.stderr.write("hunterd bootstrap failed\n");
    process.exitCode = 1;
  }
}

void bootstrap();
