// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PublishingSettingsPanel } from "../components/publishing-settings-panel";
import type { HunterApi, NpmPublishingCredentialStatus } from "../lib/api";
import { I18nProvider } from "../lib/i18n";
import { ToastProvider } from "../components/ui/Toast";

const readyStatus: NpmPublishingCredentialStatus = {
  scope: "@hunter-harness",
  source: "managed",
  state: "ready",
  username: "hunterzheng",
  expires_at: "2026-11-09T23:59:59.999Z",
  last_verified_at: "2026-08-11T12:00:00.000Z",
  can_manage: true
};

describe("PublishingSettingsPanel", () => {
  const api = {
    getNpmPublishingStatus: vi.fn(async () => ({ ...readyStatus })),
    replaceNpmPublishingCredential: vi.fn(async () => ({ ...readyStatus })),
    verifyNpmPublishingCredential: vi.fn(async () => ({ ...readyStatus })),
    clearNpmPublishingCredential: vi.fn(async () => ({
      ...readyStatus,
      source: "deployment" as const,
      state: "configured" as const,
      username: null,
      expires_at: null,
      last_verified_at: null
    }))
  } as unknown as HunterApi;

  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
    cleanup();
  });

  it("shows credential status and a complete token application guide with direct links", async () => {
    render(<ToastProvider><PublishingSettingsPanel api={api} /></ToastProvider>);

    await waitFor(() => expect(screen.getByText("hunterzheng")).toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "npm 发布设置" })).toBeInTheDocument();
    expect(screen.getAllByText("页面托管").length).toBeGreaterThan(0);
    expect(screen.getByText("@hunter-harness")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "如何申请 npm Token" })).toBeInTheDocument();
    expect(screen.getAllByText(/Packages and scopes/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Read and write/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Bypass 2FA/).length).toBeGreaterThan(0);
    expect(screen.getByText(/组织权限本身不授予包发布权/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "打开 npm Token 设置" }))
      .toHaveAttribute("href", "https://www.npmjs.com/settings/~/tokens");
    expect(screen.getByRole("link", { name: "npm 官方创建 Token 步骤" }))
      .toHaveAttribute("href", "https://docs.npmjs.com/creating-and-viewing-access-tokens/");

    const guide = screen.getByRole("heading", { name: "如何申请 npm Token" }).closest("article");
    expect(guide).not.toBeNull();
    expect(within(guide as HTMLElement).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual([
      "登录并创建 Granular Access Token",
      "允许非交互发布",
      "授权包 Scope",
      "设置有效期",
      "可选：限制服务器 IP",
      "生成、复制并立即保存"
    ]);
  });

  it("defaults the token expiry to 90 calendar days from today", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 11, 12, 0, 0));

    render(<ToastProvider><PublishingSettingsPanel api={api} /></ToastProvider>);

    expect(screen.getByLabelText(/Token 到期日/)).toHaveValue("2026-11-09");
  });

  it("keeps an intentionally cleared date visually empty without a native placeholder", () => {
    render(<ToastProvider><PublishingSettingsPanel api={api} /></ToastProvider>);
    const expiryInput = screen.getByLabelText(/Token 到期日/);

    fireEvent.change(expiryInput, { target: { value: "" } });

    expect(expiryInput).toHaveAttribute("data-empty", "true");
    expect(expiryInput).not.toHaveAttribute("placeholder");
  });

  it("uses the same 90-day expiry behavior and explicit label in English", async () => {
    window.localStorage.setItem("hunter-harness-lang", "en");
    render(
      <I18nProvider>
        <ToastProvider><PublishingSettingsPanel api={api} /></ToastProvider>
      </I18nProvider>
    );

    const expiryInput = await screen.findByLabelText("Token expiry date (90-day default)");
    expect((expiryInput as HTMLInputElement).value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(expiryInput).not.toHaveAttribute("placeholder");
  });

  it("verifies and saves a write-only token, then clears the input", async () => {
    render(<ToastProvider><PublishingSettingsPanel api={api} /></ToastProvider>);
    await waitFor(() => expect(api.getNpmPublishingStatus).toHaveBeenCalledTimes(1));

    const tokenInput = screen.getByLabelText("npm Token");
    fireEvent.change(tokenInput, { target: { value: "npm_new_secret" } });
    fireEvent.change(screen.getByLabelText("Token 到期日（默认 90 天）"), { target: { value: "2026-11-09" } });
    fireEvent.click(screen.getByRole("button", { name: "验证并保存" }));

    await waitFor(() => expect(api.replaceNpmPublishingCredential).toHaveBeenCalledWith({
      token: "npm_new_secret",
      expires_at: "2026-11-09T23:59:59.999Z"
    }));
    expect(tokenInput).toHaveValue("");
  });

  it("tests the active credential and removes only the managed credential", async () => {
    render(<ToastProvider><PublishingSettingsPanel api={api} /></ToastProvider>);
    await waitFor(() => expect(screen.getByText("hunterzheng")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "测试当前凭据" }));
    await waitFor(() => expect(api.verifyNpmPublishingCredential).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "删除页面托管凭据" }));
    await waitFor(() => expect(api.clearNpmPublishingCredential).toHaveBeenCalledTimes(1));
    expect(screen.getAllByText("部署 Secret").length).toBeGreaterThan(0);
  });
});
