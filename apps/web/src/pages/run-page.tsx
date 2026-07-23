import { useCallback, useEffect, useRef, useState } from "react";
import type { RunViewHttpResponse } from "@hunter/api-contracts";
import { RunIdSchema, type RunId, type StepRunId } from "@hunter/domain/ids";

import type { HunterApi } from "../api/client.js";
import { RunLine } from "../components/run-line.js";
import { StepDetail } from "../components/step-detail.js";
import {
  useRunEvents,
  type AuthorizedRunEventStream,
  type RunEventConnection,
} from "../hooks/use-run-events.js";

type RunApi = Pick<HunterApi, "getRun">;

const RUN_STATUS_LABELS: { readonly [Status in RunViewHttpResponse["status"]]: string } = {
  created: "已创建",
  running: "运行中",
  waiting_approval: "等待批准",
  paused: "已暂停",
  succeeded: "已成功",
  failed: "已失败",
  canceled: "已取消",
  needs_attention: "需要处理",
};

function EventConnectionNotice({ connection }: { readonly connection: RunEventConnection }) {
  switch (connection.status) {
    case "unavailable":
      return null;
    case "live":
      return <p role="status" aria-label="实时更新状态" className="message notice-message">实时更新已连接</p>;
    case "reconnecting":
      return <p role="status" aria-label="实时更新状态" className="message notice-message">实时更新中断，正在重新连接…</p>;
    case "resync_required":
      return <p role="alert" className="message error-message">事件历史已超出保留范围，需要重新同步 Run 快照。</p>;
    case "invalid_event":
      return <p role="alert" className="message error-message">收到无效事件，实时结果未被采用。</p>;
  }
}

function ValidatedRunPage({
  runId,
  api,
  eventStream,
}: {
  readonly runId: RunId;
  readonly api: RunApi;
  readonly eventStream: AuthorizedRunEventStream | undefined;
}) {
  const [run, setRun] = useState<RunViewHttpResponse>();
  const [selected, setSelected] = useState<StepRunId>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const requestEpoch = useRef(0);

  const refresh = useCallback(() => {
    const epoch = requestEpoch.current + 1;
    requestEpoch.current = epoch;
    setError(false);
    void Reflect.apply(api.getRun, api, [runId])
      .then((response) => {
        if (requestEpoch.current !== epoch || response.runId !== runId) return;
        setRun(response);
        setSelected((current) => response.steps.some(({ stepRunId }) => stepRunId === current)
          ? current
          : response.steps[0]?.stepRunId);
      })
      .catch(() => {
        if (requestEpoch.current === epoch) setError(true);
      })
      .finally(() => {
        if (requestEpoch.current === epoch) setLoading(false);
      });
  }, [api, runId]);
  const connection = useRunEvents(runId, refresh, eventStream);

  useEffect(() => {
    setRun(undefined);
    setSelected(undefined);
    setLoading(true);
    setError(false);
    refresh();
    return () => {
      requestEpoch.current += 1;
    };
  }, [refresh]);

  if (loading || (run !== undefined && run.runId !== runId)) {
    return <main className="page-shell"><p role="status">正在加载 Run…</p></main>;
  }
  if (error || run === undefined) {
    return <main className="page-shell"><p role="alert" className="message error-message">无法加载 Run，请稍后重试。</p></main>;
  }
  const selectedStep = run.steps.find(({ stepRunId }) => stepRunId === selected) ?? run.steps[0];

  return (
    <main className="page-shell run-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Execution cockpit</p>
          <h1>Run {run.runId}</h1>
        </div>
        <span className="count-label">{RUN_STATUS_LABELS[run.status]}</span>
      </header>
      <EventConnectionNotice connection={connection} />
      {run.steps.length === 0 ? (
        <div className="empty-state"><strong>还没有 Step 运行记录</strong><p>运行开始后，Step 和每一次 Attempt 会保留在这里。</p></div>
      ) : (
        <div className="run-layout">
          <nav className="panel run-navigation" aria-label="Run Step 导航">
            <RunLine steps={run.steps} selected={selectedStep?.stepRunId} onSelect={setSelected} />
          </nav>
          {selectedStep === undefined ? null : <StepDetail step={selectedStep} />}
        </div>
      )}
    </main>
  );
}

export function RunPage({
  runId: rawRunId,
  api,
  eventStream,
}: {
  readonly runId: string;
  readonly api: RunApi;
  readonly eventStream?: AuthorizedRunEventStream | undefined;
}) {
  const parsedRunId = RunIdSchema.safeParse(rawRunId);
  if (!parsedRunId.success) {
    return <main className="page-shell"><p role="alert" className="message error-message">Run 标识无效，无法打开运行详情。</p></main>;
  }
  return <ValidatedRunPage runId={parsedRunId.data} api={api} eventStream={eventStream} />;
}
