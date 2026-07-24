import type { RunStepHttpView } from "@hunter/api-contracts";
import type { StepRunId } from "@hunter/domain/ids";

const CONCLUSION_LABELS: { readonly [Conclusion in RunStepHttpView["conclusion"]]: string } = {
  active: "进行中",
  succeeded: "成功",
  failed: "失败",
  blocked: "已阻塞",
  canceled: "已取消",
};

export function RunLine({
  steps,
  selected,
  onSelect,
}: {
  readonly steps: readonly RunStepHttpView[];
  readonly selected: StepRunId | undefined;
  readonly onSelect: (stepRunId: StepRunId) => void;
}) {
  return (
    <ol className="run-line" aria-label="工作流执行线路">
      {steps.map((step) => (
        <li className="run-line-item" data-conclusion={step.conclusion} key={step.stepRunId}>
          <button
            className="run-step-button"
            type="button"
            aria-label={`${step.title} · ${CONCLUSION_LABELS[step.conclusion]}`}
            aria-current={selected === step.stepRunId ? "step" : undefined}
            onClick={() => onSelect(step.stepRunId)}
          >
            <span>{step.title}</span>
            <span className="run-step-status">{CONCLUSION_LABELS[step.conclusion]}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}
