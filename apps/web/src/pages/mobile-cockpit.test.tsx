// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MobileCommandEnvelopeSchema,
  type MobileCommandEnvelope,
  type MobileRunProjection,
} from "@hunter/device-gateway";
import { MobileCockpit, MobileUnavailablePage } from "./mobile-cockpit.js";

afterEach(cleanup);

const approveCommand = MobileCommandEnvelopeSchema.parse({
  projectId: "prj_mobile00001",
  runId: "run_mobile00001",
  gateId: "gat_mobile00001",
  expectedVersion: 3,
  idempotencyKey: "mobile-approve-0001",
  action: "approve_gate",
  payload: {},
});

function run(overrides: Partial<MobileRunProjection> = {}): MobileRunProjection {
  return {
    projectId: approveCommand.projectId,
    runId: approveCommand.runId,
    projectName: "Hunter",
    currentStep: "approve_plan",
    attention: "等待批准",
    connection: "online",
    commands: [approveCommand],
    ...overrides,
  };
}

describe("MobileCockpit", () => {
  it("renders a focused 390px cockpit and forwards the complete envelope unchanged", () => {
    const onCommand = vi.fn(async (command: MobileCommandEnvelope) => {
      void command;
    });
    render(<MobileCockpit runs={[run()]} onCommand={onCommand} />);

    expect(screen.getByText("等待批准")).not.toBeNull();
    expect(screen.getByText("approve_plan")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "批准" }));
    expect(onCommand).toHaveBeenCalledWith(approveCommand);
    expect(onCommand.mock.calls[0]![0]).toBe(approveCommand);
    for (const forbidden of ["编辑工作流", "权限策略", "打开终端", "完整源码"]) {
      expect(screen.queryByText(forbidden)).toBeNull();
    }
  });

  it("announces pending and offline states in text and disables every action", async () => {
    let finish: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const onCommand = vi.fn(() => pending);
    const { rerender } = render(<MobileCockpit runs={[run()]} onCommand={onCommand} />);
    fireEvent.click(screen.getByRole("button", { name: "批准" }));
    expect(await screen.findByText("正在提交命令，请勿重复操作。")).not.toBeNull();
    expect(screen.getByRole("button", { name: "批准" })).toHaveProperty("disabled", true);
    finish?.();

    rerender(<MobileCockpit runs={[run({ connection: "offline" })]} onCommand={vi.fn(async () => undefined)} />);
    expect(await screen.findByText("主机离线；当前内容仅供查看。")).not.toBeNull();
    expect(screen.getByRole("button", { name: "批准" })).toHaveProperty("disabled", true);
  });

  it("fails closed when the mobile authority has not been configured", () => {
    render(<MobileUnavailablePage />);
    expect(screen.getByRole("alert").textContent).toContain("远程访问尚未配置");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("announces a rejected command without implying that state changed", async () => {
    const onCommand = vi.fn(async (command: MobileCommandEnvelope) => {
      void command;
      throw new Error("transport detail must not be shown");
    });
    render(<MobileCockpit runs={[run()]} onCommand={onCommand} />);
    fireEvent.click(screen.getByRole("button", { name: "批准" }));

    expect((await screen.findByRole("alert")).textContent).toBe("命令未提交；Hunter 状态未改变。");
    expect(screen.getByRole("button", { name: "批准" })).toHaveProperty("disabled", false);
    expect(screen.queryByText("transport detail must not be shown")).toBeNull();
  });
});
