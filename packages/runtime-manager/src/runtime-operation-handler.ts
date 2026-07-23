import {
  ExternalOperationSchema,
  decodeExternalOperationReceipt,
  decodeExternalOperationReconciliation,
  type ExternalOperation,
  type ExternalOperationHandler,
  type ExternalOperationReconciler,
  type ExternalOperationReconciliation,
  type ExternalOperationReceipt,
} from "@hunter/runtime-contracts";
import type { InspectableExternalOperationHandler } from "@hunter/storage";

function isInspectable(handler: ExternalOperationHandler): handler is ExternalOperationHandler & { inspect(operation: ExternalOperation): Promise<ExternalOperationReceipt | null> } {
  return "inspect" in handler && typeof handler.inspect === "function";
}

function isReconciler(
  handler: ExternalOperationHandler,
): handler is ExternalOperationHandler & ExternalOperationReconciler {
  return "reconcile" in handler && typeof handler.reconcile === "function";
}

export class RuntimeOperationHandler implements InspectableExternalOperationHandler, ExternalOperationReconciler {
  public constructor(private readonly adapter: ExternalOperationHandler) {}

  public async execute(input: ExternalOperation): Promise<ExternalOperationReceipt> {
    const operation = ExternalOperationSchema.parse(input);
    const receipt = decodeExternalOperationReceipt(await this.adapter.execute(operation));
    if (receipt.operationId !== operation.operationId || receipt.fingerprint !== operation.fingerprint) {
      throw new Error("RUNTIME_RECEIPT_IDENTITY_MISMATCH");
    }
    return receipt;
  }

  public async inspect(operation: ExternalOperation): Promise<ExternalOperationReceipt | null> {
    const reconciled = await this.reconcile(operation);
    return reconciled.outcome === "attached" ? reconciled.receipt : null;
  }

  public async reconcile(
    operation: ExternalOperation,
  ): Promise<ExternalOperationReconciliation> {
    const parsedOperation = ExternalOperationSchema.parse(operation);
    if (isReconciler(this.adapter)) {
      return decodeExternalOperationReconciliation(
        await this.adapter.reconcile(parsedOperation),
      );
    }
    if (!isInspectable(this.adapter)) return { outcome: "unknown" };
    const receipt = await this.adapter.inspect(parsedOperation);
    return receipt === null
      ? { outcome: "unknown" }
      : {
          outcome: "attached",
          receipt: decodeExternalOperationReceipt(receipt),
        };
  }
}
