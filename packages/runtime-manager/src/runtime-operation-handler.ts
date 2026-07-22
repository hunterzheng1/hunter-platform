import {
  ExternalOperationReceiptSchema,
  ExternalOperationSchema,
  type ExternalOperation,
  type ExternalOperationHandler,
  type ExternalOperationReceipt,
} from "@hunter/runtime-contracts";

export class RuntimeOperationHandler implements ExternalOperationHandler {
  public constructor(private readonly adapter: ExternalOperationHandler) {}

  public async execute(input: ExternalOperation): Promise<ExternalOperationReceipt> {
    const operation = ExternalOperationSchema.parse(input);
    const receipt = ExternalOperationReceiptSchema.parse(await this.adapter.execute(operation));
    if (receipt.operationId !== operation.operationId || receipt.fingerprint !== operation.fingerprint) {
      throw new Error("RUNTIME_RECEIPT_IDENTITY_MISMATCH");
    }
    return receipt;
  }
}
