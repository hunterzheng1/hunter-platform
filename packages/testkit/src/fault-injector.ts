export const FAULT_POINTS = [
  "after_command_commit_before_provider_call",
  "after_provider_success_before_receipt_commit",
  "after_receipt_commit_before_outbox_complete",
  "during_duplicate_delivery",
] as const;

export type FaultPoint = (typeof FAULT_POINTS)[number];

export class InjectedFault extends Error {
  public constructor(public readonly point: FaultPoint) {
    super(`INJECTED_FAULT:${point}`);
    this.name = "InjectedFault";
  }
}

export class FaultInjector {
  #fired = false;

  public constructor(private readonly selectedPoint?: FaultPoint) {}

  public hit(point: FaultPoint): void {
    if (!this.#fired && point === this.selectedPoint) {
      this.#fired = true;
      throw new InjectedFault(point);
    }
  }
}
