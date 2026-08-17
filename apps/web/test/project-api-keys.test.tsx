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

  it("selects every permission scope by default", async () => {
    sessionStorage.setItem("hunter-harness-token", "hh_test");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] })
    }));

    wrap(<ProjectApiKeysPanel projectId="prj_demo" />);

    await waitFor(() => expect(screen.getByText(/尚未签发|No keys issued/i)).toBeTruthy());
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(9);
    for (const checkbox of checkboxes) {
      expect(checkbox).toBeChecked();
    }
    expect(screen.getByText("files:write")).toBeVisible();
    expect(screen.getByText("archive:read")).toBeVisible();
    expect(screen.getByText("archive:write")).toBeVisible();
  });

  it("shows inline errors when label or scopes are missing", async () => {
    sessionStorage.setItem("hunter-harness-token", "hh_test");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] })
    }));

    wrap(<ProjectApiKeysPanel projectId="prj_demo" />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /签发密钥|Issue key/i })).toBeDisabled();
    });

    const issue = screen.getByRole("button", { name: /签发密钥|Issue key/i });
    // Clear default push scope
    const checkboxes = screen.getAllByRole("checkbox");
    for (const box of checkboxes) {
      if ((box as HTMLInputElement).checked) fireEvent.click(box);
    }
    expect(issue).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText(/用途标签|Purpose label/i), {
      target: { value: "laptop" }
    });
    // still no scopes
    expect(issue).toBeDisabled();
  });

  it("issues a key when label and scopes are valid", async () => {
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
            scopes: ["push"],
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
  });
});
