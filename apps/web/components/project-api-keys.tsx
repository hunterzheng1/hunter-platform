"use client";

import { useCallback, useEffect, useState } from "react";

import { storedToken } from "../lib/auth";
import { useI18n } from "../lib/i18n";

const SCOPES = ["push", "knowledge:write", "progress:write", "files:read"] as const;

interface KeyItem {
  key_id: string;
  label: string;
  scopes: string[];
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

const COPY = {
  zh: {
    title: "项目 API 密钥",
    hint: "供 hunter-harness CLI 使用（hunter-harness connect <url>）。明文只显示一次。",
    label: "用途标签",
    scopes: "权限范围",
    create: "签发密钥",
    creating: "签发中…",
    created: "新密钥（请立即复制，仅显示一次）：",
    empty: "尚未签发密钥。",
    revoke: "吊销",
    revoked: "已吊销",
    lastUsed: "最近使用",
    never: "从未",
    needLogin: "管理密钥需要登录（/login）。",
    failed: "操作失败，请重试。"
  },
  en: {
    title: "Project API keys",
    hint: "Used by the hunter-harness CLI (hunter-harness connect <url>). Plaintext is shown only once.",
    label: "Label",
    scopes: "Scopes",
    create: "Issue key",
    creating: "Issuing…",
    created: "New key (copy now, shown only once): ",
    empty: "No keys issued yet.",
    revoke: "Revoke",
    revoked: "Revoked",
    lastUsed: "Last used",
    never: "never",
    needLogin: "Sign in (/login) to manage keys.",
    failed: "The operation failed. Please retry."
  }
} as const;

export function ProjectApiKeysPanel({ projectId }: { projectId: string }) {
  const { lang } = useI18n();
  const copy = COPY[lang];
  const [items, setItems] = useState<KeyItem[] | null>(null);
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<string[]>(["push"]);
  const [busy, setBusy] = useState(false);
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const token = storedToken();

  const refresh = useCallback(async () => {
    if (token === null) return;
    const response = await fetch(`/api/v1/projects/${projectId}/api-keys`, {
      headers: { Accept: "application/json", Authorization: "Bearer " + token }
    });
    if (response.ok) {
      const payload = (await response.json()) as { items: KeyItem[] };
      setItems(payload.items);
    } else {
      setItems([]);
      setMessage(response.status === 401 || response.status === 403 ? copy.needLogin : copy.failed);
    }
  }, [projectId, token, copy]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleCreate(): Promise<void> {
    if (token === null || label.trim() === "" || scopes.length === 0) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/v1/projects/${projectId}/api-keys`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: "Bearer " + token
        },
        body: JSON.stringify({ label: label.trim(), scopes })
      });
      if (!response.ok) {
        setMessage(response.status === 401 || response.status === 403 ? copy.needLogin : copy.failed);
        return;
      }
      const payload = (await response.json()) as { api_key: string };
      setPlaintext(payload.api_key);
      setLabel("");
      await refresh();
    } catch {
      setMessage(copy.failed);
    } finally {
      setBusy(false);
    }
  }

  async function handleRevoke(keyId: string): Promise<void> {
    if (token === null) return;
    setMessage(null);
    const response = await fetch(`/api/v1/projects/${projectId}/api-keys/${keyId}`, {
      method: "DELETE",
      headers: { Accept: "application/json", Authorization: "Bearer " + token }
    });
    if (!response.ok) setMessage(copy.failed);
    await refresh();
  }

  function toggleScope(scope: string): void {
    setScopes((current) => current.includes(scope)
      ? current.filter((item) => item !== scope)
      : [...current, scope]);
  }

  return (
    <section className="api-keys-panel">
      <h3>{copy.title}</h3>
      <p className="lede">{copy.hint}</p>
      <div className="api-keys-create">
        <input
          value={label}
          placeholder={copy.label}
          onChange={(event) => setLabel(event.target.value)}
          disabled={busy}
        />
        <div className="api-keys-scopes">
          {SCOPES.map((scope) => (
            <label key={scope}>
              <input
                type="checkbox"
                checked={scopes.includes(scope)}
                onChange={() => toggleScope(scope)}
              />
              {scope}
            </label>
          ))}
        </div>
        <button disabled={busy || label.trim() === "" || scopes.length === 0} onClick={() => void handleCreate()}>
          {busy ? copy.creating : copy.create}
        </button>
      </div>
      {plaintext === null ? null : (
        <p className="api-keys-plaintext">{copy.created}<code>{plaintext}</code></p>
      )}
      {message === null ? null : <p className="api-keys-message">{message}</p>}
      {items === null ? null : items.length === 0 ? (
        <p className="lede">{copy.empty}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{copy.label}</th>
              <th>{copy.scopes}</th>
              <th>{copy.lastUsed}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.key_id}>
                <td>{item.label}</td>
                <td>{item.scopes.join(", ")}</td>
                <td>{item.last_used_at === null ? copy.never : item.last_used_at.slice(0, 19).replace("T", " ")}</td>
                <td>
                  {item.revoked_at !== null ? (
                    <span>{copy.revoked}</span>
                  ) : (
                    <button onClick={() => void handleRevoke(item.key_id)}>{copy.revoke}</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
