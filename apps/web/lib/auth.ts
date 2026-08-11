"use client";

// P2 auth client: username/password login -> hhs_ session token stored in
// sessionStorage under the same key the API client already reads.

export const TOKEN_STORAGE_KEY = "hunter-harness-token";

export interface AuthUser {
  user_id: string;
  username: string;
  display_name: string;
  actor_id: string;
  system_role: "owner" | "member";
}

const base = process.env.NEXT_PUBLIC_HUNTER_HARNESS_API_URL ?? "";

async function post<T>(path: string, body: unknown, token?: string): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json"
  };
  if (token !== undefined) headers.Authorization = "Bearer " + token;
  const response = await fetch(base + path, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const error = payload.error as { code?: string; message?: string } | undefined;
    throw new AuthError(response.status, error?.code ?? "HTTP_ERROR", error?.message ?? "");
  }
  return payload as T;
}

export class AuthError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export async function fetchAuthStatus(): Promise<{ usersExist: boolean }> {
  const response = await fetch(base + "/api/v1/auth/status", {
    headers: { Accept: "application/json" }
  });
  if (!response.ok) throw new AuthError(response.status, "HTTP_ERROR", "auth status failed");
  const payload = (await response.json()) as { users_exist: boolean };
  return { usersExist: payload.users_exist };
}

export async function login(username: string, password: string): Promise<{
  token: string;
  expiresAt: string;
  user: AuthUser;
}> {
  const payload = await post<{ token: string; expires_at: string; user: AuthUser }>(
    "/api/v1/auth/login",
    { username, password }
  );
  return { token: payload.token, expiresAt: payload.expires_at, user: payload.user };
}

export async function register(input: {
  username: string;
  password: string;
  displayName?: string;
  inviteCode?: string;
}): Promise<AuthUser> {
  const payload = await post<{ user: AuthUser }>("/api/v1/auth/register", {
    username: input.username,
    password: input.password,
    ...(input.displayName === undefined || input.displayName === ""
      ? {}
      : { display_name: input.displayName }),
    ...(input.inviteCode === undefined || input.inviteCode === ""
      ? {}
      : { invite_code: input.inviteCode })
  });
  return payload.user;
}

export async function fetchMe(token: string): Promise<AuthUser | null> {
  const response = await fetch(base + "/api/v1/auth/me", {
    headers: { Accept: "application/json", Authorization: "Bearer " + token }
  });
  if (!response.ok) return null;
  const payload = (await response.json()) as { user: AuthUser };
  return payload.user;
}

export async function logout(token: string): Promise<void> {
  await post("/api/v1/auth/logout", {}, token).catch(() => undefined);
}

export async function createInvite(token: string): Promise<{
  inviteCode: string;
  expiresAt: string;
}> {
  const payload = await post<{ invite_code: string; expires_at: string }>(
    "/api/v1/auth/invites",
    {},
    token
  );
  return { inviteCode: payload.invite_code, expiresAt: payload.expires_at };
}

export function storedToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
}

export function setStoredToken(token: string): void {
  window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
}

export function clearStoredToken(): void {
  window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
}

export function isSessionToken(token: string | null): token is string {
  return token !== null && token.startsWith("hhs_");
}
