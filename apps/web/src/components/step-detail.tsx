import type { RunStepHttpView, StepAttemptHttpView } from "@hunter/api-contracts";

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

export function StepDetail({ step }: { readonly step: RunStepHttpView }) {
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
          {step.attempts.map((attempt) => (
            <article className="attempt-card" key={attempt.attemptId}>
              <h3>第 {attempt.attemptNumber} 次尝试 · {EXECUTION_LABELS[attempt.executionStatus]}</h3>
              <p>执行：{EXECUTION_LABELS[attempt.executionStatus]} · 验证：{VERIFICATION_LABELS[attempt.verificationStatus]}</p>
              {attempt.agentProfileId === undefined ? null : <p>Agent Profile：<code>{attempt.agentProfileId}</code></p>}
              <p>证据：{attempt.evidenceIds.length} 项</p>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
