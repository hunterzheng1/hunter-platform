import { useEffect, useState } from "react";

import type {
  MobileCommandAction,
  MobileCommandEnvelope,
  MobileRunProjection,
  MobileStepKind,
} from "@hunter/device-gateway/mobile-contracts";
import type {
  MobileCommandOutbox,
  PendingMobileCommand,
} from "../mobile/command-outbox.js";

import "../styles/mobile.css";

const ACTION_LABELS: Readonly<Record<MobileCommandAction, string>> = {
  approve_gate: "批准",
  reject_gate: "拒绝",
  supplement_input: "补充指令",
  pause_run: "暂停",
  resume_run: "继续",
  terminate_run: "终止",
};

const STEP_LABELS: Readonly<Record<MobileStepKind, string>> = {
  agent: "Agent 执行",
  command: "受控命令",
  verify: "结果验证",
  human_gate: "人工审批",
  context: "上下文准备",
  subflow: "子流程",
};

export function MobileUnavailablePage() {
  return (
    <main className="mobile-cockpit">
      <h1>Hunter Pocket</h1>
      <p role="alert" className="mobile-status">
        远程访问尚未配置。请先在受信任的 Hunter 桌面端完成安全设置。
      </p>
    </main>
  );
}

export function MobileCockpit({
  runs,
  offline = false,
  pendingCommands = [],
  onCommand,
}: {
  readonly runs: readonly MobileRunProjection[];
  readonly offline?: boolean | undefined;
  readonly pendingCommands?: readonly PendingMobileCommand[] | undefined;
  readonly onCommand: (command: MobileCommandEnvelope) => Promise<void>;
}) {
  const [pendingKey, setPendingKey] = useState<string>();
  const [commandFailed, setCommandFailed] = useState(false);

  const submit = (command: MobileCommandEnvelope) => {
    if (pendingKey !== undefined) return;
    setCommandFailed(false);
    setPendingKey(command.idempotencyKey);
    void onCommand(command)
      .catch(() => setCommandFailed(true))
      .finally(() => setPendingKey(undefined));
  };

  return (
    <main className="mobile-cockpit">
      <header>
        <p className="mobile-eyebrow">受限远程驾驶舱</p>
        <h1>Hunter Pocket</h1>
      </header>
      {offline
        ? (
            <p role="status" className="mobile-status">
              主机离线；仅显示本机缓存和未确认命令。
            </p>
          )
        : null}
      {pendingKey === undefined
        ? null
        : <p role="status" className="mobile-status">正在提交命令，请勿重复操作。</p>}
      {commandFailed
        ? <p role="alert" className="mobile-status">命令未提交；Hunter 状态未改变。</p>
        : null}
      {pendingCommands.map(({ command, cachedAt, confirmation }) => (
        <p
          key={command.idempotencyKey}
          role="status"
          className="mobile-status"
        >
          {confirmation === "unconfirmed" ? "未确认" : confirmation}
          {" · "}
          expected version {command.expectedVersion}
          {" · "}
          缓存于 {cachedAt}
        </p>
      ))}
      {runs.map((run) => {
        const offline = run.connection === "offline";
        const disabled = offline || pendingKey !== undefined;
        return (
          <article key={run.runId}>
            <h2>{run.projectName}</h2>
            <p className="mobile-step">{STEP_LABELS[run.currentStep]}</p>
            <strong>{run.attention}</strong>
            {offline
              ? (
                  <>
                    <p role="status" className="mobile-status">
                      主机离线；当前内容仅供查看。
                    </p>
                    <p className="mobile-status">
                      缓存摘要时间：{run.cachedAt}
                    </p>
                  </>
                )
              : <p className="mobile-status">安全连接可用</p>}
            <div className="mobile-actions">
              {run.commands.map((command) => (
                <button
                  key={command.idempotencyKey}
                  type="button"
                  disabled={disabled}
                  onClick={() => submit(command)}
                >
                  {ACTION_LABELS[command.action]}
                </button>
              ))}
            </div>
          </article>
        );
      })}
    </main>
  );
}

export function MobileCockpitWithOutbox({
  runs,
  offline = false,
  outbox,
  transport,
}: {
  readonly runs: readonly MobileRunProjection[];
  readonly offline?: boolean | undefined;
  readonly outbox: Pick<MobileCommandOutbox, "pending" | "submit">;
  readonly transport: (command: MobileCommandEnvelope) => Promise<unknown>;
}) {
  const [pendingCommands, setPendingCommands] = useState<
    readonly PendingMobileCommand[]
  >([]);
  useEffect(() => {
    let active = true;
    void outbox.pending().then((pending) => {
      if (active) setPendingCommands(pending);
    });
    return () => {
      active = false;
    };
  }, [outbox]);
  const onCommand = async (command: MobileCommandEnvelope) => {
    try {
      const terminal = await outbox.submit(command, transport);
      if (terminal.status !== "accepted") {
        throw new Error("MOBILE_COMMAND_NOT_ACCEPTED");
      }
    } finally {
      setPendingCommands(await outbox.pending());
    }
  };
  return (
    <MobileCockpit
      runs={runs}
      offline={offline}
      pendingCommands={pendingCommands}
      onCommand={onCommand}
    />
  );
}
