import {
  ExternalOperationReceiptSchema,
  ExternalOperationSchema,
  type ExternalOperation,
  type ExternalOperationHandler,
  type ExternalOperationReceipt,
} from "@hunter/runtime-contracts";
import type { InspectableExternalOperationHandler } from "@hunter/storage";

function isInspectable(handler: ExternalOperationHandler): handler is ExternalOperationHandler & { inspect(operation: ExternalOperation): Promise<ExternalOperationReceipt | null> } {
  return "inspect" in handler && typeof handler.inspect === "function";
}

export class RuntimeOperationHandler implements InspectableExternalOperationHandler {
  public constructor(private readonly adapter: ExternalOperationHandler) {}

  public async execute(input: ExternalOperation): Promise<ExternalOperationReceipt> {
    const operation = ExternalOperationSchema.parse(input);
    const receipt = ExternalOperationReceiptSchema.parse(await this.adapter.execute(operation));
    if (receipt.operationId !== operation.operationId || receipt.fingerprint !== operation.fingerprint) {
      throw new Error("RUNTIME_RECEIPT_IDENTITY_MISMATCH");
    }
    return receipt;
  }

  public async inspect(operation: ExternalOperation): Promise<ExternalOperationReceipt | null> {
    if (!isInspectable(this.adapter)) return null;
    const receipt = await this.adapter.inspect(ExternalOperationSchema.parse(operation));
    return receipt === null ? null : ExternalOperationReceiptSchema.parse(receipt);
  }
}
