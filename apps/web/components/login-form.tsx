"use client";

import { useEffect, useState, type FormEvent } from "react";

import {
  AuthError,
  fetchAuthStatus,
  login,
  register,
  setStoredToken
} from "../lib/auth";
import { useI18n } from "../lib/i18n";

type Mode = "login" | "register-first" | "register-invite";

export function LoginForm() {
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode>("login");
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchAuthStatus()
      .then((status) => {
        if (!cancelled) {
          setMode(status.usersExist ? "login" : "register-first");
          setStatusLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setStatusLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function completeLogin(user: string, pass: string): Promise<void> {
    const session = await login(user, pass);
    setStoredToken(session.token);
    window.location.assign("/");
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setMessage(null);
    setBusy(true);
    try {
      if (mode === "login") {
        await completeLogin(username.trim(), password);
      } else {
        await register({
          username: username.trim(),
          password,
          displayName: displayName.trim(),
          ...(mode === "register-invite" ? { inviteCode: inviteCode.trim() } : {})
        });
        setMessage(t.auth.registered);
        await completeLogin(username.trim(), password);
      }
    } catch (error) {
      if (error instanceof AuthError) {
        if (mode === "login") {
          setMessage(error.status === 401 ? t.auth.loginFailed : t.auth.networkError);
        } else {
          setMessage(t.auth.registerFailed + (error.message || error.code));
        }
      } else {
        setMessage(t.auth.networkError);
      }
    } finally {
      setBusy(false);
    }
  }

  const isRegister = mode !== "login";
  const title = isRegister ? t.auth.registerTitle : t.auth.loginTitle;
  const subtitle = mode === "register-first"
    ? t.auth.registerFirstSubtitle
    : mode === "register-invite"
      ? t.auth.registerInviteSubtitle
      : t.auth.loginSubtitle;

  return (
    <section className="login-card">
      <h1>{title}</h1>
      <p>{subtitle}</p>
      <form className="token-form" onSubmit={(event) => { void handleSubmit(event); }}>
        <label htmlFor="auth-username">{t.auth.username}</label>
        <input
          id="auth-username"
          autoComplete="username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          disabled={busy || !statusLoaded}
        />
        <label htmlFor="auth-password">{t.auth.password}</label>
        <input
          id="auth-password"
          type="password"
          autoComplete={isRegister ? "new-password" : "current-password"}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={busy || !statusLoaded}
        />
        {isRegister ? (
          <>
            <label htmlFor="auth-display-name">{t.auth.displayName}</label>
            <input
              id="auth-display-name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              disabled={busy}
            />
          </>
        ) : null}
        {mode === "register-invite" ? (
          <>
            <label htmlFor="auth-invite">{t.auth.inviteCode}</label>
            <input
              id="auth-invite"
              value={inviteCode}
              onChange={(event) => setInviteCode(event.target.value)}
              disabled={busy}
            />
          </>
        ) : null}
        <button type="submit" disabled={busy || !statusLoaded}>
          {busy ? t.auth.working : isRegister ? t.auth.registerButton : t.auth.loginButton}
        </button>
        {message === null ? null : <span>{message}</span>}
      </form>
      {mode === "login" ? (
        <button className="link-button" type="button" onClick={() => setMode("register-invite")}>
          {t.auth.switchToRegister}
        </button>
      ) : mode === "register-invite" ? (
        <button className="link-button" type="button" onClick={() => setMode("login")}>
          {t.auth.switchToLogin}
        </button>
      ) : null}
    </section>
  );
}
