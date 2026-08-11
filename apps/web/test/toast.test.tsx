// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ToastFeedback, ToastProvider, useToast } from "../components/ui/Toast";

afterEach(cleanup);

function ToastProbe() {
  const toast = useToast();
  return <button type="button" onClick={() => toast.danger("保存失败，请重试")}>触发通知</button>;
}

describe("global operation notifications", () => {
  it("renders a dismissible danger notification in the top-right viewport", () => {
    const { container } = render(<ToastProvider><ToastProbe /></ToastProvider>);
    fireEvent.click(screen.getByRole("button", { name: "触发通知" }));

    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("data-slot", "toast");
    expect(alert).toHaveTextContent("保存失败，请重试");
    fireEvent.click(within(alert).getByRole("button", { name: /关闭通知|dismiss notification/i }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(container.querySelector('[data-slot="toast-viewport"]')).toBeInTheDocument();

    const css = readFileSync(resolve(process.cwd(), "apps/web/app/globals.css"), "utf8");
    const viewportRule = css.match(/\.toast-stack\s*\{[^}]+\}/s)?.[0] ?? "";
    expect(viewportRule).toMatch(/right:\s*(?:24|32)px/);
    expect(viewportRule).not.toMatch(/left:\s*50%/);
  });

  it("relays legacy operation state without leaving page-bottom content", () => {
    const { container } = render(
      <ToastProvider><main><ToastFeedback tone="success" message="技能上传完成" /></main></ToastProvider>
    );

    expect(screen.getByRole("status")).toHaveTextContent("技能上传完成");
    expect(container.querySelector("main")).toBeEmptyDOMElement();
  });
});
