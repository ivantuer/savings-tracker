CREATE TABLE IF NOT EXISTS vaults (
  id TEXT PRIMARY KEY,
  auth_hash TEXT NOT NULL,
  rev INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  iv TEXT NOT NULL,
  blob TEXT NOT NULL,
  wrap TEXT,
  prev_iv TEXT,
  prev_blob TEXT
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Google backup sign-in: maps a Google account to a vault and holds that vault's credentials, sealed with a key from meta.
CREATE TABLE IF NOT EXISTS links (
  sub TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL,
  iv TEXT NOT NULL,
  sealed TEXT NOT NULL,
  created_at TEXT NOT NULL
);
