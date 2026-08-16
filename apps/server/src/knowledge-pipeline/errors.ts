export class KnowledgePipelineError extends Error {
  readonly reason_code: string;
  readonly retryable: boolean;

  constructor(reason_code: string, retryable: boolean, message = reason_code) {
    super(message);
    this.name = "KnowledgePipelineError";
    this.reason_code = reason_code;
    this.retryable = retryable;
  }
}
