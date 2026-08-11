"use client";

import { useEffect, useMemo, useState } from "react";

import {
  ApiClientError,
  browserApi,
  type HunterApi,
  type NpmPublishingCredentialStatus
} from "../lib/api";
import { useI18n } from "../lib/i18n";
import { PageHeader } from "./ui/PageHeader";
import { Icon } from "./ui/icons";
import { Spinner } from "./ui/Spinner";
import { useToast } from "./ui/Toast";

const NPM_TOKEN_SETTINGS_URL = "https://www.npmjs.com/settings/~/tokens";
const NPM_TOKEN_DOCS_URL = "https://docs.npmjs.com/creating-and-viewing-access-tokens/";
const NPM_TOKEN_ABOUT_URL = "https://docs.npmjs.com/about-access-tokens/";
const NPM_CI_DOCS_URL = "https://docs.npmjs.com/using-private-packages-in-a-ci-cd-workflow/";

const COPY = {
  zh: {
    eyebrow: "系统设置",
    title: "npm 发布设置",
    lede: "服务器保存一次发布凭据，之后在技能页面只需确认版本并点击发布。",
    loading: "正在读取发布配置…",
    loadFailed: "无法读取 npm 发布配置。请确认当前账号是服务器 Owner。",
    statusTitle: "发布凭据",
    ready: "凭据有效",
    configured: "已配置，尚未在本次运行中验证",
    notConfigured: "尚未配置",
    expired: "凭据已过期",
    invalid: "凭据无效",
    locked: "加密主密钥不可用",
    managed: "页面托管",
    deployment: "部署 Secret",
    none: "无凭据",
    identity: "npm 身份",
    scope: "发布 Scope",
    expires: "到期时间",
    verified: "最近验证",
    unknown: "未提供",
    test: "测试当前凭据",
    testing: "正在验证…",
    remove: "删除页面托管凭据",
    removing: "正在删除…",
    formTitle: "配置或轮换 Token",
    formHint: "新 Token 会先通过 npm 身份验证，验证成功后才原子替换旧凭据。现有 Token 永远不会回显。",
    tokenLabel: "npm Token",
    tokenPlaceholder: "粘贴 npm Granular Access Token",
    expiryLabel: "Token 到期日（默认 90 天）",
    save: "验证并保存",
    saving: "正在验证并保存…",
    managedLocked: "服务器尚未配置凭据加密主密钥，当前只能使用部署 Secret。",
    saved: "npm Token 已验证并加密保存。",
    tested: "当前 npm 凭据验证通过。",
    removed: "页面托管凭据已删除。",
    tokenRequired: "请先粘贴 npm Token。",
    operationFailed: "操作失败，请检查 Token 权限或网络后重试。",
    tokenInvalid: "npm 拒绝了该 Token，请检查 Scope、Read and write 与 Bypass 2FA。",
    tokenExpired: "该 Token 的到期时间无效或已经过期。",
    guideTitle: "如何申请 npm Token",
    guideIntro: "按下面步骤创建一次，后续轮换时重复同样流程即可。不要把 Token 发到聊天、Git 或截图中。",
    openSettings: "打开 npm Token 设置",
    officialDocs: "npm 官方创建 Token 步骤",
    aboutDocs: "Granular Token 权限说明",
    ciDocs: "npm 自动发布安全建议",
    step1Title: "登录并创建 Granular Access Token",
    step1Body: "打开 npm Token 设置，选择生成新的 Granular Access Token。名称建议填写 hunter-platform-server。",
    step2Title: "设置有效期",
    step2Body: "建议在 npm 设置 90 天或更短的有效期。本页已自动填入当前日期 90 天后的日期；如果 npm 选择不同日期，请同步修改。",
    step3Title: "授权包 Scope",
    step3Body: "在 Packages and scopes 中选择 @hunter-harness，并把权限设为 Read and write。不要只配置 Organization 权限。",
    step4Title: "允许非交互发布",
    step4Body: "开启 Bypass 2FA。否则服务器点击发布时会被一次性验证码阻塞。",
    step5Title: "可选：限制服务器 IP",
    step5Body: "如果服务器出口 IP 固定，可添加 CIDR 白名单，进一步缩小 Token 可用范围。",
    step6Title: "生成、复制并立即保存",
    step6Body: "npm 只会完整展示 Token 一次。复制后回到这里粘贴，点击“验证并保存”，成功后即可只点“发布”。",
    warningTitle: "关键权限提醒",
    warningBody: "组织权限本身不授予包发布权；必须在 Packages and scopes 中明确选择 @hunter-harness。若包启用了 disallow tokens，Token 也会被拒绝。",
    rotateTitle: "Token 过期或轮换时",
    rotateBody: "在 npm 创建一个新 Token，回到本页验证并保存；确认新凭据有效后，再到 npm 撤销旧 Token。无需登录服务器，也无需重启 Docker。"
  },
  en: {
    eyebrow: "System settings",
    title: "npm publishing",
    lede: "Store the publishing credential once, then publish skills with a single confirmed action.",
    loading: "Loading publishing configuration…",
    loadFailed: "Unable to load npm publishing configuration. Confirm this account is the server Owner.",
    statusTitle: "Publishing credential",
    ready: "Credential ready",
    configured: "Configured, not verified in this process",
    notConfigured: "Not configured",
    expired: "Credential expired",
    invalid: "Credential invalid",
    locked: "Encryption key unavailable",
    managed: "Managed in console",
    deployment: "Deployment secret",
    none: "No credential",
    identity: "npm identity",
    scope: "Publishing scope",
    expires: "Expires",
    verified: "Last verified",
    unknown: "Not provided",
    test: "Test current credential",
    testing: "Verifying…",
    remove: "Remove managed credential",
    removing: "Removing…",
    formTitle: "Configure or rotate token",
    formHint: "A new token is verified before it atomically replaces the current credential. Stored tokens are never displayed.",
    tokenLabel: "npm Token",
    tokenPlaceholder: "Paste an npm Granular Access Token",
    expiryLabel: "Token expiry date (90-day default)",
    save: "Verify and save",
    saving: "Verifying and saving…",
    managedLocked: "The server encryption key is unavailable; only a deployment secret can be used.",
    saved: "npm token verified and encrypted.",
    tested: "The active npm credential is valid.",
    removed: "The managed credential was removed.",
    tokenRequired: "Paste an npm token first.",
    operationFailed: "The operation failed. Check token permissions and network access, then retry.",
    tokenInvalid: "npm rejected this token. Check its scope, Read and write permission, and Bypass 2FA setting.",
    tokenExpired: "The token expiry is invalid or has already passed.",
    guideTitle: "How to create an npm token",
    guideIntro: "Follow these steps once and repeat them for rotations. Never share the token in chat, Git, or screenshots.",
    openSettings: "Open npm token settings",
    officialDocs: "Official token creation steps",
    aboutDocs: "Granular token permissions",
    ciDocs: "npm automation security guidance",
    step1Title: "Create a Granular Access Token",
    step1Body: "Open npm token settings and generate a new granular token. Suggested name: hunter-platform-server.",
    step2Title: "Choose an expiration",
    step2Body: "Use 90 days or a shorter period in npm. This field defaults to 90 calendar days from today; update it if npm uses a different date.",
    step3Title: "Grant package-scope access",
    step3Body: "Under Packages and scopes, select @hunter-harness and choose Read and write. Organization access alone is insufficient.",
    step4Title: "Allow non-interactive publishing",
    step4Body: "Enable Bypass 2FA so server publishing is not blocked by an OTP prompt.",
    step5Title: "Optional: restrict server IPs",
    step5Body: "If the server has a stable egress IP, add a CIDR allowlist to reduce the token's usable surface.",
    step6Title: "Copy once and save immediately",
    step6Body: "npm shows the full token once. Paste it here and choose Verify and save; future releases only need Publish.",
    warningTitle: "Permission reminder",
    warningBody: "Organization access does not grant package publishing. Select @hunter-harness under Packages and scopes. Packages that disallow tokens will still reject it.",
    rotateTitle: "When the token expires",
    rotateBody: "Create a replacement on npm, verify and save it here, then revoke the old token. No server login or Docker restart is required."
  }
} as const;

function formatDate(value: string | null, lang: "zh" | "en", dateOnly = false): string | null {
  if (value === null) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  return new Intl.DateTimeFormat(lang === "zh" ? "zh-CN" : "en", {
    year: "numeric",
    month: "short",
    day: "numeric",
    ...(dateOnly ? { timeZone: "UTC" } : { hour: "2-digit", minute: "2-digit" })
  }).format(parsed);
}

function defaultTokenExpiryDate(now = new Date()): string {
  const date = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() + 90));
  return date.toISOString().slice(0, 10);
}

function errorCopy(
  error: unknown,
  copy: { operationFailed: string; tokenInvalid: string; tokenExpired: string }
): string {
  if (error instanceof ApiClientError && error.code === "NPM_CREDENTIAL_INVALID") {
    return copy.tokenInvalid;
  }
  if (error instanceof ApiClientError && error.code === "NPM_CREDENTIAL_EXPIRED") {
    return copy.tokenExpired;
  }
  return copy.operationFailed;
}

export function PublishingSettingsPanel({ api: apiValue }: { api?: HunterApi }) {
  const { lang } = useI18n();
  const copy = COPY[lang];
  const api = useMemo(() => apiValue ?? browserApi(), [apiValue]);
  const toast = useToast();
  const [status, setStatus] = useState<NpmPublishingCredentialStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [expiry, setExpiry] = useState(() => defaultTokenExpiryDate());
  const [busy, setBusy] = useState<"save" | "verify" | "remove" | null>(null);

  useEffect(() => {
    let active = true;
    if (api.getNpmPublishingStatus === undefined) {
      setError(copy.loadFailed);
      return () => { active = false; };
    }
    void api.getNpmPublishingStatus().then((value) => {
      if (active) setStatus(value);
    }).catch(() => {
      if (active) setError(copy.loadFailed);
    });
    return () => { active = false; };
  }, [api, copy.loadFailed]);

  async function saveCredential(): Promise<void> {
    if (token.trim() === "") {
      toast.warning(copy.tokenRequired);
      return;
    }
    if (api.replaceNpmPublishingCredential === undefined) return;
    setBusy("save");
    try {
      const next = await api.replaceNpmPublishingCredential({
        token: token.trim(),
        expires_at: expiry === "" ? null : `${expiry}T23:59:59.999Z`
      });
      setStatus(next);
      setToken("");
      toast.success(copy.saved);
    } catch (reason) {
      toast.danger(errorCopy(reason, copy));
    } finally {
      setBusy(null);
    }
  }

  async function verifyCredential(): Promise<void> {
    if (api.verifyNpmPublishingCredential === undefined) return;
    setBusy("verify");
    try {
      const next = await api.verifyNpmPublishingCredential();
      setStatus(next);
      toast.success(copy.tested);
    } catch (reason) {
      toast.danger(errorCopy(reason, copy));
    } finally {
      setBusy(null);
    }
  }

  async function removeCredential(): Promise<void> {
    if (api.clearNpmPublishingCredential === undefined) return;
    setBusy("remove");
    try {
      setStatus(await api.clearNpmPublishingCredential());
      setToken("");
      setExpiry(defaultTokenExpiryDate());
      toast.info(copy.removed);
    } catch (reason) {
      toast.danger(errorCopy(reason, copy));
    } finally {
      setBusy(null);
    }
  }

  const stateLabel = status === null ? copy.loading : {
    ready: copy.ready,
    configured: copy.configured,
    not_configured: copy.notConfigured,
    expired: copy.expired,
    invalid: copy.invalid,
    locked: copy.locked
  }[status.state];
  const sourceLabel = status === null ? copy.none : {
    managed: copy.managed,
    deployment: copy.deployment,
    none: copy.none
  }[status.source];
  const steps = [
    [copy.step1Title, copy.step1Body],
    [copy.step4Title, copy.step4Body],
    [copy.step3Title, copy.step3Body],
    [copy.step2Title, copy.step2Body],
    [copy.step5Title, copy.step5Body],
    [copy.step6Title, copy.step6Body]
  ];

  return (
    <section className="publishing-settings" data-slot="publishing-settings">
      <PageHeader eyebrow={copy.eyebrow} title={copy.title} lede={copy.lede} />

      {error === null ? null : <div className="publishing-alert danger" role="alert">{error}</div>}

      <div className="publishing-overview" data-slot="publishing-overview">
        <article className="publishing-card credential-card" data-slot="credential-status">
          <div className="publishing-card-heading">
            <div className={`credential-state-icon state-${status?.state ?? "loading"}`}>
              <Icon name={status?.state === "ready" ? "shield" : status?.state === "expired" || status?.state === "invalid" ? "warning" : "package"} size={19} />
            </div>
            <div>
              <p className="publishing-kicker">{copy.statusTitle}</p>
              <h2>{stateLabel}</h2>
            </div>
            <span className={`publishing-source source-${status?.source ?? "none"}`}>{sourceLabel}</span>
          </div>

          {status === null ? <Spinner label={copy.loading} /> : (
            <dl className="credential-facts">
              <div><dt>{copy.identity}</dt><dd>{status.username ?? copy.unknown}</dd></div>
              <div><dt>{copy.scope}</dt><dd><code>{status.scope ?? copy.unknown}</code></dd></div>
              <div><dt>{copy.expires}</dt><dd>{formatDate(status.expires_at, lang, true) ?? copy.unknown}</dd></div>
              <div><dt>{copy.verified}</dt><dd>{formatDate(status.last_verified_at, lang) ?? copy.unknown}</dd></div>
            </dl>
          )}

          <div className="publishing-actions">
            <button type="button" className="publishing-button secondary" disabled={busy !== null || status?.source === "none"} onClick={() => void verifyCredential()}>
              <Icon name={busy === "verify" ? "loading" : "refresh"} className={busy === "verify" ? "spin" : ""} size={15} />
              {busy === "verify" ? copy.testing : copy.test}
            </button>
            {status?.source === "managed" ? (
              <button type="button" className="publishing-button danger" disabled={busy !== null} onClick={() => void removeCredential()}>
                <Icon name="trash" size={15} />
                {busy === "remove" ? copy.removing : copy.remove}
              </button>
            ) : null}
          </div>
        </article>

        <article className="publishing-card credential-form-card" data-slot="credential-form">
          <div className="publishing-card-heading compact">
            <div className="credential-state-icon state-form"><Icon name="shield" size={19} /></div>
            <div>
              <p className="publishing-kicker">{status?.source === "managed" ? copy.managed : copy.deployment}</p>
              <h2>{copy.formTitle}</h2>
            </div>
          </div>
          <p className="publishing-card-copy">{copy.formHint}</p>
          {status !== null && !status.can_manage ? <div className="publishing-alert warning">{copy.managedLocked}</div> : null}
          <div className="publishing-form-grid">
            <label className="publishing-field">
              <span>{copy.tokenLabel}</span>
              <input
                type="password"
                autoComplete="new-password"
                value={token}
                disabled={status === null || !status.can_manage}
                onChange={(event) => setToken(event.target.value)}
                placeholder={copy.tokenPlaceholder}
              />
            </label>
            <label className="publishing-field expiry-field">
              <span>{copy.expiryLabel}</span>
              <input
                type="date"
                value={expiry}
                data-empty={expiry === "" ? "true" : "false"}
                disabled={status === null || !status.can_manage}
                onChange={(event) => setExpiry(event.target.value)}
              />
            </label>
          </div>
          <button type="button" className="publishing-button primary save-credential" disabled={busy !== null || status === null || !status.can_manage} onClick={() => void saveCredential()}>
            <Icon name={busy === "save" ? "loading" : "shield"} className={busy === "save" ? "spin" : ""} size={15} />
            {busy === "save" ? copy.saving : copy.save}
          </button>
        </article>
      </div>

      <article className="publishing-guide" data-slot="token-guide">
        <div className="publishing-guide-head">
          <div>
            <p className="publishing-kicker">Granular Access Token</p>
            <h2>{copy.guideTitle}</h2>
            <p>{copy.guideIntro}</p>
          </div>
          <a className="publishing-button primary external-link" href={NPM_TOKEN_SETTINGS_URL} target="_blank" rel="noreferrer">
            {copy.openSettings}<Icon name="chevron-right" size={15} />
          </a>
        </div>

        <ol className="publishing-steps">
          {steps.map(([title, body], index) => (
            <li key={title}>
              <span className="step-number">{String(index + 1).padStart(2, "0")}</span>
              <div><h3>{title}</h3><p>{body}</p></div>
            </li>
          ))}
        </ol>

        <div className="publishing-guide-notes">
          <div className="publishing-alert warning">
            <Icon name="warning" size={17} />
            <div><strong>{copy.warningTitle}</strong><p>{copy.warningBody}</p></div>
          </div>
          <div className="publishing-rotation">
            <Icon name="refresh" size={17} />
            <div><strong>{copy.rotateTitle}</strong><p>{copy.rotateBody}</p></div>
          </div>
        </div>

        <footer className="publishing-doc-links">
          <a href={NPM_TOKEN_DOCS_URL} target="_blank" rel="noreferrer">{copy.officialDocs}</a>
          <a href={NPM_TOKEN_ABOUT_URL} target="_blank" rel="noreferrer">{copy.aboutDocs}</a>
          <a href={NPM_CI_DOCS_URL} target="_blank" rel="noreferrer">{copy.ciDocs}</a>
        </footer>
      </article>
    </section>
  );
}
