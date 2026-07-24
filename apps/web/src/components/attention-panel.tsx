import { useState } from "react";
import type {
  AttentionActionHttpRequest,
  AttentionActionHttpResponse,
  AttentionActionKindHttp,
  AttentionEvidenceRefHttp,
  AttentionItemHttp,
} from "@hunter/api-contracts";
import type { AttemptId } from "@hunter/domain";

const REASON_LABELS: {
  readonly [Reason in AttentionItemHttp["reasonCode"]]: string;
} = {
  input_required: "需要补充输入",
  human_verification_required: "等待人工验证",
  verifier_failed: "验证未通过",
  verifier_error: "验证器发生错误",
  runtime_session_stale: "Runtime Session 已失效",
  recovery_attention_required: "恢复检查需要人工处理",
  external_operation_indeterminate: "外部操作结果尚未证明",
};

const ACTOR_LABELS: {
  readonly [Actor in AttentionItemHttp["requiredActor"]]: string;
} = {
  human_operator: "人工操作员",
  hunter_runtime: "Hunter Runtime",
  hunter_verifier: "Hunter Verifier",
};

const ACTION_LABELS: {
  readonly [Action in AttentionActionKindHttp]: string;
} = {
  submit_input: "补充输入",
  record_human_receipt: "记录人工验证",
  confirm_external_result: "确认外部观察",
  retry_external_check: "重新检查外部状态",
  create_new_attempt: "创建新的 Attempt",
};

const CAPABILITY_REASON_LABELS = {
  capability_supported: "能力已证明",
  capability_unsupported: "能力不受支持",
  capability_receipt_missing: "缺少能力探针凭据",
  observe_not_proven: "能力尚未证明",
  retry_not_proven: "能力尚未证明",
} as const;

const DISABLED_REASON_LABELS = {
  attempt_limit_reached: "已达到 Attempt 上限",
  run_budget_exhausted: "Run 预算不足",
  action_not_available: "当前状态不允许此动作",
} as const;

export type AttentionActionDraft =
  AttentionActionHttpRequest extends infer Command
    ? Command extends AttentionActionHttpRequest
      ? Omit<Command, "attemptId" | "expectedVersion" | "idempotencyKey">
      : never
    : never;

async function canonicalTextSha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(text));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function evidenceReferenceKey(reference: AttentionEvidenceRefHttp): string {
  return "evidenceId" in reference
    ? `evidence:${reference.evidenceId}`
    : `flow-event:${reference.eventId}`;
}

function evidenceReferenceLabel(reference: AttentionEvidenceRefHttp): string {
  return "evidenceId" in reference
    ? reference.evidenceId
    : reference.eventId;
}

export function AttentionPanel({
  attemptId,
  attention,
  onAction,
  interactionDisabledReason,
}: {
  readonly attemptId: AttemptId;
  readonly attention: AttentionItemHttp;
  readonly onAction?: (action: AttentionActionDraft) =>
    Promise<AttentionActionHttpResponse>;
  readonly interactionDisabledReason?: string;
}) {
  const [pending, setPending] = useState<AttentionActionKindHttp>();
  const [message, setMessage] = useState<
    { readonly kind: "error" | "success"; readonly text: string } | undefined
  >();
  const [inputText, setInputText] = useState("");
  const [selectedEvidenceKey, setSelectedEvidenceKey] = useState(
    attention.evidence[0] === undefined
      ? ""
      : evidenceReferenceKey(attention.evidence[0]),
  );
  const [observationFact, setObservationFact] = useState<
    "session_running" | "session_missing" | "agent_returned" | "structured_process_exit"
  >("session_missing");

  const execute = async (draft: AttentionActionDraft) => {
    if (onAction === undefined || pending !== undefined) return;
    setPending(draft.action);
    setMessage(undefined);
    try {
      const response = await onAction(draft);
      setMessage({
        kind: "success",
        text: response.stepCompletion === "verifier_required"
          ? "观察已记录；Step 仍需 verifier 结果。"
          : response.stepCompletion === "human_verified"
            ? "人工 verifier 收据已记录。"
            : "动作已记录；Step 状态未被直接完成。",
      });
    } catch {
      setMessage({
        kind: "error",
        text: "动作未完成，请刷新 Run 后重试。",
      });
    } finally {
      setPending(undefined);
    }
  };
  const selectedEvidence = attention.evidence.find(
    (reference) =>
      evidenceReferenceKey(reference) === selectedEvidenceKey,
  );
  const executeAvailableAction = async (
    availability: AttentionItemHttp["actions"][number],
  ): Promise<void> => {
    const { action } = availability;
    if (action === "submit_input") {
      const text = inputText.trim();
      if (text.length === 0) return;
      await execute({
        action,
        input: {
          text,
          contentHash: await canonicalTextSha256(text),
        },
      });
      return;
    }
    if (action === "record_human_receipt") {
      if (selectedEvidence === undefined) return;
      await execute({
        action,
        receipt: {
          evidenceRef: selectedEvidence,
          acknowledgedInputHash: attention.inputRevision.fixedContentHash,
        },
      });
      return;
    }
    if (action === "confirm_external_result") {
      const confirmationEvidence =
        selectedEvidence !== undefined && "evidenceId" in selectedEvidence
          ? selectedEvidence
          : attention.evidence.find(
              (reference) => "evidenceId" in reference,
            );
      if (
        confirmationEvidence === undefined
        || !("evidenceId" in confirmationEvidence)
      ) return;
      await execute({
        action,
        observation: {
          fact: observationFact,
          ...confirmationEvidence,
        },
      });
      return;
    }
    if (action === "retry_external_check") {
      if (availability.capability === undefined) return;
      await execute({
        action,
        capabilityProbeReceiptId:
          availability.capability.probeReceiptId,
      });
      return;
    }
    await execute({ action });
  };

  return (
    <section className="attention-panel" aria-labelledby={`attention-${attemptId}`}>
      <h4 id={`attention-${attemptId}`}>需要处理</h4>
      <p><strong>{REASON_LABELS[attention.reasonCode]}</strong></p>
      <p>处理人：{ACTOR_LABELS[attention.requiredActor]}</p>
      <div>
        <h5>固定输入版本</h5>
        <ul>
          <li><code>{attention.inputRevision.changeRevisionId}</code></li>
          <li><code>{attention.inputRevision.workflowRevisionId}</code></li>
          {attention.inputRevision.requirementRevisionIds.map((revisionId) => (
            <li key={revisionId}><code>{revisionId}</code></li>
          ))}
        </ul>
      </div>
      <div>
        <h5>关联证据</h5>
        <ul>
          {attention.evidence.map((reference) => (
            <li key={evidenceReferenceKey(reference)}>
              <code>{evidenceReferenceLabel(reference)}</code>
              {" · "}
              <code>{reference.contentHash}</code>
            </li>
          ))}
        </ul>
        <label>
          选择证据
          <select
            aria-label="选择证据"
            value={selectedEvidenceKey}
            onChange={(event) =>
              setSelectedEvidenceKey(event.currentTarget.value)}
          >
            {attention.evidence.map((reference) => (
              <option
                key={evidenceReferenceKey(reference)}
                value={evidenceReferenceKey(reference)}
              >
                {evidenceReferenceLabel(reference)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="attention-actions">
        {attention.actions.map((availability) => {
          const disabled = !availability.enabled
            || pending !== undefined
            || onAction === undefined
            || interactionDisabledReason !== undefined;
          return (
            <div key={availability.action}>
              {availability.action === "submit_input" ? (
                <label>
                  补充输入内容
                  <textarea
                    aria-label="补充输入内容"
                    value={inputText}
                    maxLength={4_000}
                    onChange={(event) => setInputText(event.currentTarget.value)}
                  />
                </label>
              ) : null}
              {availability.action === "confirm_external_result" ? (
                <label>
                  外部观察事实
                  <select
                    aria-label="外部观察事实"
                    value={observationFact}
                    onChange={(event) => setObservationFact(
                      event.currentTarget.value as typeof observationFact,
                    )}
                  >
                    <option value="session_running">Session 仍在运行</option>
                    <option value="session_missing">Session 不存在</option>
                    <option value="agent_returned">Agent 已返回</option>
                    <option value="structured_process_exit">进程已退出</option>
                  </select>
                </label>
              ) : null}
              <button
                className="button button-secondary"
                type="button"
                disabled={disabled}
                onClick={() => void executeAvailableAction(availability)}
              >
                {pending === availability.action
                  ? "处理中…"
                  : ACTION_LABELS[availability.action]}
              </button>
              {availability.capability === undefined ? null : (
                <p className="capability-reason">
                  {CAPABILITY_REASON_LABELS[availability.capability.reasonCode]}
                  {" · "}
                  <code>{availability.capability.probeReceiptId}</code>
                </p>
              )}
              {availability.disabledReasonCode === undefined ? null : (
                <p className="capability-reason">
                  {DISABLED_REASON_LABELS[availability.disabledReasonCode]}
                </p>
              )}
            </div>
          );
        })}
      </div>
      {interactionDisabledReason === undefined ? null : (
        <p className="capability-reason">{interactionDisabledReason}</p>
      )}
      {message === undefined ? null : (
        <p
          role={message.kind === "error" ? "alert" : "status"}
          className={`message ${message.kind === "error" ? "error-message" : "notice-message"}`}
        >
          {message.text}
        </p>
      )}
    </section>
  );
}
