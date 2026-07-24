import { KnowledgeResolver } from "@hunter/knowledge";

import { ApplicationStartRunService } from "./start-run.js";
import { createSqliteApplicationServices } from "./sqlite-application-services.js";

export type ApplicationCompositionInput = Parameters<
  typeof createSqliteApplicationServices
>[0];

/**
 * Production application composition boundary.
 *
 * SQLite remains the single unit of work for the Event Ledger, Flow state,
 * outbox, receipts, leases, Archive jobs, and Knowledge projection. Runtime
 * and verifier implementations enter only through provider-neutral ports in
 * the input. Test fixtures compose this same boundary from outside `src`.
 */
export function createApplicationComposition(
  input: ApplicationCompositionInput,
) {
  const services = createSqliteApplicationServices(input);
  const startRun = new ApplicationStartRunService(
    services.startRun,
    services.flowStore,
  );
  const knowledge = services.knowledgeCatalog === undefined
    ? undefined
    : new KnowledgeResolver(services.knowledgeCatalog);

  return {
    services,
    startRun,
    knowledge,
  };
}
