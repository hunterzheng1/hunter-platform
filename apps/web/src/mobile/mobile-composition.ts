import { ProjectIdSchema } from "@hunter/domain/ids";
import { z } from "zod";

import { MobileCommandOutbox } from "./command-outbox.js";
import { CredentialVault } from "./credential-vault.js";
import { DeviceKeyStore } from "./device-key.js";
import { MobileRuntime } from "./mobile-runtime.js";

export const MobileBootstrapConfigurationSchema = z.strictObject({
  apiOrigin: z.string().min(1).max(2_048),
  projectIds: ProjectIdSchema.array().min(1).max(100),
});

export interface MobilePlatform {
  readonly indexedDB: IDBFactory;
  readonly crypto: Crypto;
  readonly fetch: typeof fetch;
}

export function createMobileComposition(
  candidate: unknown,
  platform: MobilePlatform,
): {
  readonly runtime: MobileRuntime;
  readonly outbox: MobileCommandOutbox;
} | undefined {
  const configuration = MobileBootstrapConfigurationSchema.safeParse(candidate);
  if (!configuration.success) return undefined;
  const keys = new DeviceKeyStore({
    indexedDB: platform.indexedDB,
    crypto: platform.crypto,
  });
  const vault = new CredentialVault({
    indexedDB: platform.indexedDB,
    keys,
  });
  try {
    return {
      runtime: new MobileRuntime({
        ...configuration.data,
        vault,
        keys,
        fetch: platform.fetch,
      }),
      outbox: new MobileCommandOutbox({ indexedDB: platform.indexedDB }),
    };
  } catch {
    return undefined;
  }
}
