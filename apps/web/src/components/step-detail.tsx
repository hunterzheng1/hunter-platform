import type {
  ArtifactPageHttpResponse,
  AttentionActionHttpResponse,
  RunStepHttpView,
  StepAttemptHttpView,
} from "@hunter/api-contracts";
import type { ArtifactId, AttemptId } from "@hunter/domain";
import { useRef, useState } from "react";

import {
  AttentionPanel,
  type AttentionActionDraft,
} from "./attention-panel.js";

const EXECUTION_LABELS: { readonly [Status in StepAttemptHttpView["executionStatus"]]: string } = {
  assigned: "已分配",
  running: "执行中",
  waiting_input: "等待输入",
  returned: "已返回",
  failed: "执行失败",
  canceled: "已取消",
  stale: "已失效",
  needs_attention: "需要处理",
};

const VERIFICATION_LABELS: { readonly [Status in StepAttemptHttpView["verificationStatus"]]: string } = {
  pending: "待验证",
  verifying: "验证中",
  passed: "通过",
  failed: "失败",
  error: "验证错误",
  needs_human: "等待人工确认",
  canceled: "已取消",
};

const WAITING_REASON_LABELS: { readonly [Code in NonNullable<StepAttemptHttpView["waitingReason"]>["code"]]: string } = {
  input_required: "等待输入",
  human_verification_required: "等待人工验证",
  recovery_attention_required: "等待恢复处理",
  external_operation_indeterminate: "外部操作状态待确认",
};

type ArtifactPageState =
  | {
      readonly artifactId: ArtifactId;
      readonly status: "loading";
    }
  | {
      readonly artifactId: ArtifactId;
      readonly status: "loaded";
      readonly response: ArtifactPageHttpResponse;
    }
  | {
      readonly artifactId: ArtifactId;
      readonly status: "error";
      readonly message: string;
    };

export function StepDetail({
  step,
  onAttentionAction,
  loadArtifactPage,
}: {
  readonly step: RunStepHttpView;
  readonly onAttentionAction?: (
    attemptId: AttemptId,
    action: AttentionActionDraft,
  ) => Promise<AttentionActionHttpResponse>;
  readonly loadArtifactPage?: (
    artifactId: ArtifactId,
    cursor: number,
  ) => Promise<ArtifactPageHttpResponse>;
}) {
  const [artifactPage, setArtifactPage] = useState<ArtifactPageState>();
  const artifactRequestSequence = useRef(0);

  async function loadPage(artifactId: ArtifactId, cursor: number): Promise<void> {
    if (loadArtifactPage === undefined) {
      return;
    }
    const requestSequence = artifactRequestSequence.current + 1;
    artifactRequestSequence.current = requestSequence;
    setArtifactPage({ artifactId, status: "loading" });
    try {
      const response = await loadArtifactPage(artifactId, cursor);
      if (artifactRequestSequence.current === requestSequence) {
        setArtifactPage({ artifactId, status: "loaded", response });
      }
    } catch (error) {
      if (artifactRequestSequence.current === requestSequence) {
        setArtifactPage({
          artifactId,
          status: "error",
          message: error instanceof Error ? error.message : "无法读取产物分页。",
        });
      }
    }
  }

  function renderArtifactPage(artifactId: ArtifactId) {
    if (artifactPage?.artifactId !== artifactId) {
      return null;
    }
    if (artifactPage.status === "loading") {
      return <p role="status">正在读取当前页…</p>;
    }
    if (artifactPage.status === "error") {
      return <p role="alert">读取失败：{artifactPage.message}</p>;
    }
    if (artifactPage.response.status === "resync_required") {
      return (
        <div role="alert">
          <p>较早日志已按保留策略清理；当前保留点为 {artifactPage.response.retentionFloor}。</p>
          <button
            type="button"
            onClick={() => void loadPage(
              artifactId,
              artifactPage.response.retentionFloor,
            )}
          >
            从保留点重新同步
          </button>
        </div>
      );
    }

    const page = artifactPage.response;
    return (
      <div className="artifact-page">
        <p>
          {page.artifact.summary} · 游标 {page.cursor}–{page.nextCursor}
          {" "}· 保留点 {page.retentionFloor} · 高水位 {page.highWaterCursor}
        </p>
        {page.entries.length === 0
          ? <p>当前页没有日志条目。</p>
          : page.entries.map((entry) => (
              <pre key={entry.cursor}>{entry.content}</pre>
            ))}
        {page.complete
          ? null
          : (
              <button
                type="button"
                onClick={() => void loadPage(artifactId, page.nextCursor)}
              >
                加载下一页
              </button>
            )}
      </div>
    );
  }

  return (
    <section className="step-detail panel" aria-labelledby={`step-detail-${step.stepRunId}`}>
      <div className="section-heading">
        <div>
          <p className="eyebrow">Step detail</p>
          <h2 id={`step-detail-${step.stepRunId}`}>{step.title}详情</h2>
        </div>
      </div>
      {step.attempts.length === 0 ? (
        <div className="empty-state compact-empty"><strong>还没有 Attempt 记录</strong></div>
      ) : (
        <div className="attempt-list">
          {step.attempts.map((attempt, attemptIndex) => (
            <article className="attempt-card" key={attempt.attemptId}>
              <h3>第 {attempt.attemptNumber} 次尝试 · {EXECUTION_LABELS[attempt.executionStatus]}</h3>
              <p>执行：{EXECUTION_LABELS[attempt.executionStatus]} · 验证：{VERIFICATION_LABELS[attempt.verificationStatus]}</p>
              {attempt.agentProfileId === undefined ? null : <p>Agent Profile：<code>{attempt.agentProfileId}</code></p>}
              {attempt.nativeSessionId === undefined ? null : <p>Hunter Session：<code>{attempt.nativeSessionId}</code></p>}
              {attempt.waitingReason === undefined ? null : (
                <p className="waiting-reason"><strong>{WAITING_REASON_LABELS[attempt.waitingReason.code]}</strong></p>
              )}
              {attempt.artifactIds.length === 0 ? <p>产物：无</p> : (
                <div>
                  <h4>产物</h4>
                  <ul>
                    {attempt.artifactIds.map((artifactId) => (
                      <li key={artifactId}>
                        <code>{artifactId}</code>
                        {loadArtifactPage === undefined ? null : (
                          <button
                            type="button"
                            aria-label={`加载产物 ${artifactId}`}
                            onClick={() => void loadPage(artifactId, 0)}
                          >
                            加载分页
                          </button>
                        )}
                        {renderArtifactPage(artifactId)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {attempt.evidenceIds.length === 0 ? <p>证据：无</p> : <div><h4>证据</h4><ul>{attempt.evidenceIds.map((evidenceId) => <li key={evidenceId}><code>{evidenceId}</code></li>)}</ul></div>}
              {attempt.attention === undefined ? null : (
                <AttentionPanel
                  attemptId={attempt.attemptId}
                  attention={attempt.attention}
                  {...(onAttentionAction === undefined
                    || attempt.isCurrent !== true
                    || attemptIndex !== step.attempts.length - 1
                    ? {}
                    : {
                        onAction: (action: AttentionActionDraft) =>
                          onAttentionAction(attempt.attemptId, action),
                      })}
                  {...(attempt.isCurrent === true
                    && attemptIndex === step.attempts.length - 1
                    ? {}
                    : { interactionDisabledReason: "历史 Attempt 只读，恢复动作只能作用于当前 Attempt。" })}
                />
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
