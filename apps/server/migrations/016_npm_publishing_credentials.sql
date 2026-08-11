BEGIN;

-- One server-wide npm publishing credential. Only the encrypted envelope is
-- stored in Postgres; the AES key is mounted separately into the server.
CREATE TABLE IF NOT EXISTS npm_publishing_credentials (
  singleton_id smallint PRIMARY KEY CHECK (singleton_id = 1),
  schema_version integer NOT NULL CHECK (schema_version = 1),
  key_id text NOT NULL,
  ciphertext text NOT NULL,
  iv text NOT NULL,
  auth_tag text NOT NULL,
  scope text NOT NULL,
  username text NOT NULL,
  expires_at timestamptz,
  last_verified_at timestamptz NOT NULL,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL
);

COMMIT;
