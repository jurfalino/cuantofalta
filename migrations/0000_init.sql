CREATE TABLE ngo (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  mp_user_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  access_token_enc TEXT,
  refresh_token_enc TEXT,
  token_expires_at TEXT,
  connected_at TEXT
);

CREATE TABLE goal (
  id TEXT PRIMARY KEY,
  ngo_id TEXT NOT NULL REFERENCES ngo(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  target_amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'ARS',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TABLE contribution (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goal(id),
  source TEXT NOT NULL,
  mp_payment_id TEXT UNIQUE,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL,
  paid_at TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_goal_ngo ON goal(ngo_id);
CREATE INDEX idx_contribution_goal ON contribution(goal_id);
