import { useState } from "react";

import type {
  MobileCommandAction,
  MobileCommandEnvelope,
  MobileRunProjection,
} from "@hunter/device-gateway/mobile-contracts";
import type { MobileCommandOutbox } from "../mobile/command-outbox.js";

import "../styles/mobile.css";

const ACTION_LABELS: Readonly<Record<MobileCommandAction, string>> = {
  approve_gate: "批准",
  reject_gate: "拒绝",
  supplement_input: "补充指令",
  pause_run: "暂停",
  resume_run: "继续",
  terminate_run: "终止",
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
  onCommand,
}: {
  readonly runs: readonly MobileRunProjection[];
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
      {pendingKey === undefined
        ? null
        : <p role="status" className="mobile-status">正在提交命令，请勿重复操作。</p>}
      {commandFailed
        ? <p role="alert" className="mobile-status">命令未提交；Hunter 状态未改变。</p>
        : null}
      {runs.map((run) => {
        const offline = run.connection === "offline";
        const disabled = offline || pendingKey !== undefined;
        return (
          <article key={run.runId}>
            <h2>{run.projectName}</h2>
            <p className="mobile-step">{run.currentStep}</p>
            <strong>{run.attention}</strong>
            {offline
              ? <p role="status" className="mobile-status">主机离线；当前内容仅供查看。</p>
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
  outbox,
  transport,
}: {
  readonly runs: readonly MobileRunProjection[];
  readonly outbox: Pick<MobileCommandOutbox, "submit">;
  readonly transport: (command: MobileCommandEnvelope) => Promise<unknown>;
}) {
  const onCommand = async (command: MobileCommandEnvelope) => {
    const terminal = await outbox.submit(command, transport);
    if (terminal.status !== "accepted") throw new Error("MOBILE_COMMAND_NOT_ACCEPTED");
  };
  return <MobileCockpit runs={runs} onCommand={onCommand} />;
}
