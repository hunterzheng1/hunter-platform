"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { storedToken } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { Icon } from "./ui/icons";
import { Modal } from "./ui/Modal";
import { ToastFeedback } from "./ui/Toast";

const SCOPES = ["push", "knowledge:read", "knowledge:write", "progress:write", "files:read"] as const;

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
    lede: "密钥供本机 hunter-harness CLI 连接平台使用。明文仅显示一次，请立即复制。",
    steps: [
      "填写用途标签",
      "勾选权限范围",
      "签发密钥",
      "复制明文密钥",
      "在本机执行 npx hunter-harness connect <平台地址> 并粘贴密钥"
    ],
    label: "用途标签",
    labelRequired: "用途标签为必填项。",
    requiredHint: "必填",
    scopes: "权限范围",
    scopesRequired: "请至少勾选一项权限。",
    create: "签发密钥",
    creating: "签发中…",
    created: "新密钥（请立即复制，仅显示一次）",
    copy: "复制",
    copied: "已复制",
    empty: "尚未签发密钥。",
    revoke: "吊销",
    revokeConfirm: "确认吊销该密钥？吊销后不可恢复。",
    revokeConfirmTitle: "吊销 API 密钥",
    confirmRevoke: "确认吊销",
    cancel: "取消",
    revokeDone: "密钥已吊销。",
    dismissPlaintext: "我已保存，关闭",
    copyFailed: "复制失败，请手动选中复制。",
    connectHint: "或在本机直接执行（密钥已包含在命令中）：",
    copyCommand: "复制命令",
    revoked: "已吊销",
    lastUsed: "最近使用",
    never: "从未",
    needLogin: "管理密钥需要登录。",
    goLogin: "前往登录",
    failed: "操作失败，请重试。",
    loading: "加载中…",
    refresh: "刷新",
    scopeHints: {
      push: "上传归档/提案文件到平台",
      "knowledge:read": "查询该项目的远端知识",
      "knowledge:write": "向项目知识库写入内容",
      "progress:write": "上报运行事件 / 心跳（运行监控）",
      "files:read": "读取项目文件快照"
    } as Record<(typeof SCOPES)[number], string>
  },
  en: {
    title: "Project API keys",
    lede: "Keys let the local hunter-harness CLI talk to this platform. Plaintext is shown only once — copy it immediately.",
    steps: [
      "Enter a purpose label",
      "Select scopes",
      "Issue the key",
      "Copy the plaintext key",
      "Run npx hunter-harness connect <platform-url> locally and paste the key"
    ],
    label: "Purpose label",
    labelRequired: "A purpose label is required.",
    requiredHint: "required",
    scopes: "Scopes",
    scopesRequired: "Select at least one scope.",
    create: "Issue key",
    creating: "Issuing…",
    created: "New key (copy now — shown only once)",
    copy: "Copy",
    copied: "Copied",
    empty: "No keys issued yet.",
    revoke: "Revoke",
    revokeConfirm: "Revoke this key? This cannot be undone.",
    revokeConfirmTitle: "Revoke API key",
    confirmRevoke: "Revoke key",
    cancel: "Cancel",
    revokeDone: "Key revoked.",
    dismissPlaintext: "I have saved it — dismiss",
    copyFailed: "Copy failed. Please select and copy the key manually.",
    connectHint: "Or run this locally (the key is embedded in the command):",
    copyCommand: "Copy command",
    revoked: "Revoked",
    lastUsed: "Last used",
    never: "never",
    needLogin: "Sign in to manage keys.",
    goLogin: "Go to sign in",
    failed: "The operation failed. Please retry.",
    loading: "Loading…",
    refresh: "Refresh",
    scopeHints: {
      push: "Upload archive / proposal files to the platform",
      "knowledge:read": "Search this project's remote knowledge",
      "knowledge:write": "Write knowledge entries (ingest)",
      "progress:write": "Report run events / heartbeats (run monitor)",
      "files:read": "Read project file snapshots"
    } as Record<(typeof SCOPES)[number], string>
  }
} as const;

export function ProjectApiKeysPanel({ projectId }: { projectId: string }) {
  const { lang } = useI18n();
  const copy = COPY[lang];
  const [items, setItems] = useState<KeyItem[] | null>(null);
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<string[]>([...SCOPES]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [commandCopied, setCommandCopied] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageTone, setMessageTone] = useState<"error" | "success">("error");
  const [pendingRevoke, setPendingRevoke] = useState<KeyItem | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [labelError, setLabelError] = useState<string | null>(null);
  const [scopeError, setScopeError] = useState<string | null>(null);
  const [needLogin, setNeedLogin] = useState(false);

  function showError(text: string): void {
    setMessageTone("error");
    setMessage(text);
  }

  function showSuccess(text: string): void {
    setMessageTone("success");
    setMessage(text);
  }

  const token = storedToken();

  const refresh = useCallback(async () => {
    if (token === null) {
      setItems([]);
      setNeedLogin(true);
      setMessage(copy.needLogin);
      return;
    }
    setLoading(true);
    setMessage(null);
    setNeedLogin(false);
    try {
      const response = await fetch(`/api/v1/projects/${projectId}/api-keys`, {
        headers: { Accept: "application/json", Authorization: "Bearer " + token }
      });
      if (response.ok) {
        const payload = (await response.json()) as { items: KeyItem[] };
        setItems(payload.items);
      } else {
        setItems([]);
        const authFail = response.status === 401 || response.status === 403;
        setNeedLogin(authFail);
        showError(authFail ? copy.needLogin : copy.failed);
      }
    } catch {
      setItems([]);
      showError(copy.failed);
    } finally {
      setLoading(false);
    }
  }, [projectId, token, copy.needLogin, copy.failed]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function validate(): boolean {
    const nextLabelError = label.trim() === "" ? copy.labelRequired : null;
    const nextScopeError = scopes.length === 0 ? copy.scopesRequired : null;
    setLabelError(nextLabelError);
    setScopeError(nextScopeError);
    return nextLabelError === null && nextScopeError === null;
  }

  async function handleCreate(): Promise<void> {
    if (!validate() || token === null) return;
    setBusy(true);
    setMessage(null);
    setPlaintext(null);
    setCopied(false);
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
        const authFail = response.status === 401 || response.status === 403;
        setNeedLogin(authFail);
        showError(authFail ? copy.needLogin : copy.failed);
        return;
      }
      const payload = (await response.json()) as { api_key: string };
      setPlaintext(payload.api_key);
      setLabel("");
      setLabelError(null);
      await refresh();
    } catch {
      showError(copy.failed);
    } finally {
      setBusy(false);
    }
  }

  async function confirmRevoke(): Promise<void> {
    if (token === null || pendingRevoke === null) return;
    setRevoking(true);
    try {
      const response = await fetch(`/api/v1/projects/${projectId}/api-keys/${pendingRevoke.key_id}`, {
        method: "DELETE",
        headers: { Accept: "application/json", Authorization: "Bearer " + token }
      });
      if (!response.ok) {
        showError(copy.failed);
      } else {
        showSuccess(copy.revokeDone);
      }
      setPendingRevoke(null);
      await refresh();
    } catch {
      showError(copy.failed);
    } finally {
      setRevoking(false);
    }
  }

  function toggleScope(scope: string): void {
    setScopes((current) => {
      const next = current.includes(scope)
        ? current.filter((item) => item !== scope)
        : [...current, scope];
      if (next.length > 0) setScopeError(null);
      return next;
    });
  }

  async function copyPlaintext(): Promise<void> {
    if (plaintext === null) return;
    try {
      await navigator.clipboard.writeText(plaintext);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      showError(copy.copyFailed);
    }
  }

  const connectCommand = plaintext === null
    ? null
    : `npx hunter-harness connect ${window.location.origin} --key ${plaintext}`;

  async function copyConnectCommand(): Promise<void> {
    if (connectCommand === null) return;
    try {
      await navigator.clipboard.writeText(connectCommand);
      setCommandCopied(true);
      window.setTimeout(() => setCommandCopied(false), 2000);
    } catch {
      showError(copy.copyFailed);
    }
  }

  const canIssue = !busy && label.trim() !== "" && scopes.length > 0;

  return (
    <section className="api-keys-panel">
      <header className="panel-section-header">
        <div>
          <h3>{copy.title}</h3>
          <p className="lede">{copy.lede}</p>
        </div>
        <button type="button" className="secondary" disabled={loading} onClick={() => void refresh()}>
          {loading ? copy.loading : copy.refresh}
        </button>
      </header>

      <ol className="api-keys-steps">
        {copy.steps.map((step, index) => (
          <li key={step}><span>{index + 1}.</span> {step}</li>
        ))}
      </ol>

      <div className="api-keys-create form-stack">
        <label className="form-field">
          <span className="form-label">{copy.label} <abbr title={copy.requiredHint}>*</abbr></span>
          <input
            value={label}
            placeholder={copy.label}
            onChange={(event) => {
              setLabel(event.target.value);
              if (event.target.value.trim() !== "") setLabelError(null);
            }}
            onBlur={() => {
              if (label.trim() === "") setLabelError(copy.labelRequired);
            }}
            disabled={busy}
            aria-invalid={labelError !== null}
          />
          {labelError === null ? null : <span className="form-error">{labelError}</span>}
        </label>

        <fieldset className="form-field">
          <legend className="form-label">{copy.scopes} <abbr title={copy.requiredHint}>*</abbr></legend>
          <div className="api-keys-scopes">
            {SCOPES.map((scope) => (
              <label key={scope} className="api-keys-scope-row">
                <input
                  type="checkbox"
                  checked={scopes.includes(scope)}
                  onChange={() => toggleScope(scope)}
                />
                <span>
                  <strong>{scope}</strong>
                  <small>{copy.scopeHints[scope]}</small>
                </span>
              </label>
            ))}
          </div>
          {scopeError === null ? null : <span className="form-error">{scopeError}</span>}
        </fieldset>

        <button
          type="button"
          className="primary"
          disabled={!canIssue}
          onClick={() => void handleCreate()}
          onMouseDown={() => {
            if (label.trim() === "" || scopes.length === 0) validate();
          }}
        >
          {busy ? copy.creating : copy.create}
        </button>
      </div>

      {plaintext === null ? null : (
        <div className="api-keys-plaintext" role="status">
          <p>{copy.created}</p>
          <code>{plaintext}</code>
          <div className="api-keys-plaintext-actions">
            <button type="button" className="secondary" onClick={() => void copyPlaintext()}>
              {copied ? <Icon name="check" size={13} /> : <Icon name="copy" size={13} />}
              {copied ? copy.copied : copy.copy}
            </button>
            <button type="button" className="text-button" onClick={() => setPlaintext(null)}>
              {copy.dismissPlaintext}
            </button>
          </div>
          <div className="api-keys-connect">
            <p>{copy.connectHint}</p>
            <div className="api-keys-connect-row">
              <code>{connectCommand}</code>
              <button type="button" className="secondary" onClick={() => void copyConnectCommand()}>
                {commandCopied ? <Icon name="check" size={13} /> : <Icon name="copy" size={13} />}
                {commandCopied ? copy.copied : copy.copyCommand}
              </button>
            </div>
          </div>
        </div>
      )}

      {message === null || !needLogin ? null : (
        <p className={messageTone === "success" ? "notice success" : "api-keys-message"} role="alert">
          {message}
          {needLogin ? <>{" "}<Link href="/login">{copy.goLogin}</Link></> : null}
        </p>
      )}
      {needLogin ? null : <ToastFeedback tone={messageTone === "success" ? "success" : "danger"} message={message} />}

      {items === null || loading ? (
        <div className="skeleton-block api-keys-skeleton" aria-busy="true" aria-label={copy.loading} />
      ) : items.length === 0 ? (
        <div className="knowledge-empty"><span>◇</span><p>{copy.empty}</p></div>
      ) : (
        <table className="data-table">
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
              <tr key={item.key_id} className={item.revoked_at !== null ? "api-key-revoked" : ""}>
                <td>{item.label}</td>
                <td>{item.scopes.join(", ")}</td>
                <td>{item.last_used_at === null ? copy.never : item.last_used_at.slice(0, 19).replace("T", " ")}</td>
                <td>
                  {item.revoked_at !== null ? (
                    <span className="api-key-revoked-label">{copy.revoked}</span>
                  ) : (
                    <button type="button" className="danger" onClick={() => setPendingRevoke(item)}>
                      {copy.revoke}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Modal
        open={pendingRevoke !== null}
        onClose={() => { if (!revoking) setPendingRevoke(null); }}
        title={copy.revokeConfirmTitle}
        closeLabel={copy.cancel}
        footer={
          <>
            <button type="button" className="secondary" disabled={revoking} onClick={() => setPendingRevoke(null)}>
              {copy.cancel}
            </button>
            <button type="button" className="danger" disabled={revoking} onClick={() => void confirmRevoke()}>
              {revoking ? copy.loading : copy.confirmRevoke}
            </button>
          </>
        }
      >
        <p>{copy.revokeConfirm}</p>
        {pendingRevoke === null ? null : <p><strong>{pendingRevoke.label}</strong></p>}
      </Modal>
    </section>
  );
}
