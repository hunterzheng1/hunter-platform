import { createHash } from "node:crypto";
import {
  EvidenceIdSchema,
  ExternalReferenceIdSchema,
  type RuntimeProviderId,
} from "@hunter/domain";
import {
  ExternalOperationReceiptSchema,
  ExternalOperationSchema,
  fingerprintExternalOperation,
  type ExternalOperation,
  type ExternalOperationHandler,
  type ExternalOperationReceipt,
  type RuntimeFact,
} from "@hunter/runtime-contracts";

export interface FakeRuntimeOptions {
  readonly providerId: RuntimeProviderId;
  readonly implementationVersion: string;
  readonly observedAt: string;
}

interface StoredExecution {
  readonly canonicalOperation: string;
  readonly receipt: ExternalOperationReceipt;
}

function derivedId(prefix: "evd" | "xrf", value: string): string {
  const suffix = createHash("sha256").update(value).digest("hex").slice(0, 24);
  return `${prefix}_${suffix}`;
}

function factsFor(operation: ExternalOperation): readonly RuntimeFact[] {
  if (operation.operationType === "session.observe") {
    return [
      { kind: "agent_returned" },
      { kind: "process_exited", exitCode: 0 },
      { kind: "terminal_idle" },
      { kind: "native_surface_opened" },
    ];
  }
  return [{ kind: "operation_accepted" }];
}

export class FakeRuntime implements ExternalOperationHandler {
  readonly #options: FakeRuntimeOptions;
  readonly #executions = new Map<string, StoredExecution>();
  #executeCount = 0;

  constructor(options: FakeRuntimeOptions) {
    this.#options = options;
  }

  async execute(input: ExternalOperation): Promise<ExternalOperationReceipt> {
    this.#executeCount += 1;
    const operation = ExternalOperationSchema.parse(input);
    if (fingerprintExternalOperation(operation) !== operation.fingerprint) {
      throw new Error("OPERATION_FINGERPRINT_MISMATCH");
    }
    const canonicalOperation = JSON.stringify(operation);
    const existing = this.#executions.get(operation.operationId);
    if (existing !== undefined) {
      if (existing.canonicalOperation !== canonicalOperation) {
        throw new Error("OPERATION_ID_REUSED_WITH_DIFFERENT_PAYLOAD");
      }
      return existing.receipt;
    }

    const receipt = ExternalOperationReceiptSchema.parse({
      schemaVersion: 1,
      operationId: operation.operationId,
      fingerprint: operation.fingerprint,
      operationStatus: "completed",
      subject: {
        kind: "provider",
        providerId: this.#options.providerId,
        implementationVersion: this.#options.implementationVersion,
      },
      nativeReferences: [
        {
          kind: operation.operationType.startsWith("workspace.") ? "workspace" : "session",
          referenceId: ExternalReferenceIdSchema.parse(
            derivedId("xrf", operation.operationId),
          ),
        },
      ],
      facts: factsFor(operation),
      evidence: {
        evidenceId: EvidenceIdSchema.parse(derivedId("evd", operation.operationId)),
        evidenceHash: createHash("sha256").update(canonicalOperation).digest("hex"),
        proofScope: "contract_only",
      },
      observedAt: this.#options.observedAt,
    });
    this.#executions.set(operation.operationId, { canonicalOperation, receipt });
    return receipt;
  }

  async inspect(input: ExternalOperation): Promise<ExternalOperationReceipt | null> {
    const operation = ExternalOperationSchema.parse(input);
    if (fingerprintExternalOperation(operation) !== operation.fingerprint) throw new Error("OPERATION_FINGERPRINT_MISMATCH");
    const existing = this.#executions.get(operation.operationId);
    if (existing === undefined) return null;
    if (existing.canonicalOperation !== JSON.stringify(operation)) throw new Error("OPERATION_ID_REUSED_WITH_DIFFERENT_PAYLOAD");
    return existing.receipt;
  }

  get executeCount(): number {
    return this.#executeCount;
  }

  get nativeEffectCount(): number {
    return this.#executions.size;
  }
}
