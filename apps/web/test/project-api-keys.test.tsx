// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectApiKeysPanel } from "../components/project-api-keys";
import { I18nProvider } from "../lib/i18n";

function wrap(ui: React.ReactElement) {
  return render(<I18nProvider>{ui}</I18nProvider>);
}

describe("ProjectApiKeysPanel", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("issues project-wide keys without any scope picker", async () => {
    sessionStorage.setItem("hunter-harness-token", "hh_test");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] })
    }));

    wrap(<ProjectApiKeysPanel projectId="prj_demo" />);

    await waitFor(() => expect(screen.getByText(/尚未签发|No keys issued/i)).toBeTruthy());
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(document.querySelectorAll(".api-keys-steps li")).toHaveLength(4);
  });

  it("requires a purpose label before issuing", async () => {
    sessionStorage.setItem("hunter-harness-token", "hh_test");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] })
    }));

    wrap(<ProjectApiKeysPanel projectId="prj_demo" />);

    await waitFor(() => expect(screen.getByText(/尚未签发|No keys issued/i)).toBeTruthy());
    const issue = screen.getByRole("button", { name: /签发密钥|Issue key/i });
    expect(issue).toBeDisabled();

    const labelInput = screen.getByPlaceholderText(/用途标签|Purpose label/i);
    fireEvent.change(labelInput, { target: { value: "laptop" } });
    expect(issue).toBeEnabled();

    fireEvent.change(labelInput, { target: { value: "   " } });
    expect(issue).toBeDisabled();

    fireEvent.blur(labelInput);
    expect(screen.getByText(/用途标签为必填项|purpose label is required/i)).toBeTruthy();
  });

  it("issues a key for the whole project and reveals the connect command", async () => {
    sessionStorage.setItem("hunter-harness-token", "hh_test");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: [] })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ api_key: "hh_plain_once" })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          items: [{
            key_id: "k1",
            label: "laptop",
            created_at: "2026-08-06T00:00:00Z",
            revoked_at: null,
            last_used_at: null
          }]
        })
      });
    vi.stubGlobal("fetch", fetchMock);

    wrap(<ProjectApiKeysPanel projectId="prj_demo" />);
    await waitFor(() => expect(screen.getByText(/尚未签发|No keys issued/i)).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/用途标签|Purpose label/i), {
      target: { value: "laptop" }
    });
    fireEvent.click(screen.getByRole("button", { name: /签发密钥|Issue key/i }));

    await waitFor(() => {
      expect(screen.getByText("hh_plain_once")).toBeTruthy();
      expect(screen.getByText("laptop")).toBeTruthy();
      expect(screen.getByText(
        "npx hunter-harness connect http://localhost:3000 --key hh_plain_once"
      )).toBeTruthy();
    });

    const createCall = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(createCall[1].body as string)).toEqual({ label: "laptop" });
  });
});
