"use client";

import { useState, useRef, useEffect } from "react";

import {
  clearStoredToken,
  createInvite,
  fetchMe,
  isSessionToken,
  logout,
  storedToken,
  type AuthUser
} from "../lib/auth";
import { useI18n } from "../lib/i18n";

function AccountSection() {
  const { t } = useI18n();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [invite, setInvite] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const token = storedToken();
    if (!isSessionToken(token)) {
      setLoaded(true);
      return;
    }
    void fetchMe(token as string).then((me) => {
      setUser(me);
      setLoaded(true);
    });
  }, []);

  async function handleLogout(): Promise<void> {
    const token = storedToken();
    if (isSessionToken(token)) await logout(token as string);
    clearStoredToken();
    window.location.assign("/login");
  }

  async function handleInvite(): Promise<void> {
    const token = storedToken();
    if (!isSessionToken(token)) return;
    setBusy(true);
    try {
      const created = await createInvite(token as string);
      setInvite(created.inviteCode);
    } catch {
      setInvite(null);
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return null;
  return (
    <div>
      <label className="settings-label">{t.auth.account}</label>
      <p className="settings-hint">{t.settings.accountLoginHint}</p>
      {user === null ? (
        <div className="token-row">
          <span>{t.auth.notLoggedIn}</span>
          <a className="token-set-btn" href="/login">{t.auth.goLogin}</a>
        </div>
      ) : (
        <>
          <div className="token-row">
            <span>{t.auth.loggedInAs}: <strong>{user.display_name}</strong></span>
            <button className="token-set-btn" onClick={() => void handleLogout()}>
              {t.auth.logout}
            </button>
          </div>
          <div className="token-row">
            <button className="token-set-btn" disabled={busy} onClick={() => void handleInvite()}>
              {t.auth.inviteButton}
            </button>
          </div>
          {invite === null ? null : (
            <small>{t.auth.inviteCreated}<code>{invite}</code></small>
          )}
        </>
      )}
    </div>
  );
}

export function ThemeToggle({ theme, setTheme }: { theme: "dark" | "light"; setTheme: (t: "dark" | "light") => void }) {
  const { t } = useI18n();
  return (
    <div>
      <label className="settings-label">{t.settings.theme}</label>
      <div className="theme-toggle-group">
        <button
          className={`theme-option ${theme === "dark" ? "active" : ""}`}
          onClick={() => setTheme("dark")}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
          {t.settings.dark}
        </button>
        <button
          className={`theme-option ${theme === "light" ? "active" : ""}`}
          onClick={() => setTheme("light")}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="5" />
            <line x1="12" y1="1" x2="12" y2="3" />
            <line x1="12" y1="21" x2="12" y2="23" />
            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
            <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
            <line x1="1" y1="12" x2="3" y2="12" />
            <line x1="21" y1="12" x2="23" y2="12" />
            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
            <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
          </svg>
          {t.settings.light}
        </button>
      </div>
    </div>
  );
}

function LanguageSwitch() {
  const { t, lang, toggleLang } = useI18n();
  const languages: { key: string; label: string; native: string }[] = [
    { key: "zh", label: "中文", native: "简体中文" },
    { key: "en", label: "English", native: "English" },
  ];

  return (
    <div>
      <label className="settings-label">{t.settings.language}</label>
      <div className="theme-toggle-group">
        {languages.map((l) => (
          <button
            key={l.key}
            className={`theme-option ${lang === l.key ? "active" : ""}`}
            onClick={() => lang !== l.key && toggleLang()}
          >
            {l.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function TokenSection() {
  const { t } = useI18n();
  const [token, setToken] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const stored = sessionStorage.getItem("hunter-harness-token");
    if (stored) setToken(stored);
  }, []);

  async function handleSet() {
    const trimmed = token.trim();
    setSaved(false);
    setMessage(null);
    if (trimmed === "") {
      sessionStorage.removeItem("hunter-harness-token");
      setMessage(t.token.removed);
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/v1/projects?limit=1", {
        headers: {
          Accept: "application/json",
          Authorization: "Bearer " + trimmed,
          "X-Request-Id": globalThis.crypto.randomUUID()
        }
      });
      if (!response.ok) {
        setMessage(response.status === 401 || response.status === 403
          ? t.token.rejected
          : t.token.httpError + response.status + ".");
        return;
      }
      sessionStorage.setItem("hunter-harness-token", trimmed);
      setSaved(true);
      setMessage(t.token.verified);
      window.setTimeout(() => window.location.reload(), 250);
    } catch {
      setMessage(t.token.unreachable);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-advanced">
      <button
        type="button"
        className="settings-advanced-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {t.settings.advancedToken}
      </button>
      {open ? (
        <div className="settings-advanced-body">
          <p className="settings-hint">{t.settings.advancedTokenHint}</p>
          <label className="settings-label" htmlFor="settings-api-token">{t.settings.apiToken}</label>
          <div className="token-row">
            <input
              id="settings-api-token"
              className="token-input"
              type="password"
              autoComplete="off"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder={t.token.placeholder}
            />
            <button className="token-set-btn" disabled={busy} onClick={() => void handleSet()}>
              {busy ? t.token.checking : saved ? t.token.saved : t.token.setButton}
            </button>
          </div>
          {message === null ? null : <small className="form-message">{message}</small>}
        </div>
      ) : null}
    </div>
  );
}

function DefaultAgentSection() {
  const { t } = useI18n();
  const [agent, setAgent] = useState("claude-code");
  useEffect(() => {
    setAgent(localStorage.getItem("hunter-harness-default-agent") ?? "claude-code");
  }, []);
  return (
    <div>
      <label className="settings-label" htmlFor="default-agent">{t.settings.defaultAgent}</label>
      <select
        id="default-agent"
        className="token-input"
        value={agent}
        onChange={(event) => {
          setAgent(event.target.value);
          localStorage.setItem("hunter-harness-default-agent", event.target.value);
        }}
      >
        <option value="claude-code">Claude Code</option>
        <option value="codex">{t.settings.codexContract}</option>
        <option value="generic">{t.settings.genericContract}</option>
        <option value="mcp">{t.settings.mcpContract}</option>
      </select>
    </div>
  );
}

export function SettingsPanel({ theme, setTheme }: { theme: "dark" | "light"; setTheme: (t: "dark" | "light") => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <div className="settings-wrapper" ref={panelRef}>
      <button className="settings-gear" onClick={() => setOpen(!open)} title={t.settings.title}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
        {t.settings.title}
      </button>

      {open && (
        <div className="settings-dropdown">
          <div className="settings-header">{t.settings.title}</div>
          <LanguageSwitch />
          <ThemeToggle theme={theme} setTheme={setTheme} />
          <DefaultAgentSection />
          <div className="settings-divider" />
          <AccountSection />
          <div className="settings-divider" />
          <TokenSection />
        </div>
      )}
    </div>
  );
}
