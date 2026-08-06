BEGIN;

-- P2 auth: human login accounts (username/password -> session token).
-- Machine access keeps using api_tokens; sessions resolve to the same actors.

CREATE TABLE IF NOT EXISTS users (
  user_id text PRIMARY KEY,
  username text NOT NULL UNIQUE,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  actor_id text NOT NULL REFERENCES actors(actor_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz
);

CREATE TABLE IF NOT EXISTS user_sessions (
  session_token_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_seen_at timestamptz
);

CREATE TABLE IF NOT EXISTS invite_codes (
  code_hash text PRIMARY KEY,
  created_by text NOT NULL REFERENCES users(user_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  -- no FK: invite is consumed atomically before the user row is inserted
  used_by text,
  used_at timestamptz
);

CREATE INDEX IF NOT EXISTS user_sessions_user_idx ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS user_sessions_expiry_idx ON user_sessions(expires_at);

COMMIT;
