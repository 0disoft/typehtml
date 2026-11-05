-- Design reference. Timestamps use epoch seconds; adapter settings are in docs/07.
PRAGMA foreign_keys = ON;
CREATE TABLE memberships (
  tenant_id TEXT NOT NULL, subject_id TEXT NOT NULL,
  active INTEGER NOT NULL CHECK(active IN (0,1)),
  PRIMARY KEY (tenant_id,subject_id)
) STRICT;
CREATE TABLE products (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991),
  active INTEGER NOT NULL CHECK(active IN (0,1)),
  price_minor INTEGER NOT NULL CHECK(price_minor BETWEEN 0 AND 9007199254740991),
  currency TEXT NOT NULL CHECK(currency='KRW'), PRIMARY KEY(tenant_id,id)
) STRICT;
CREATE TABLE form_intents (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, subject_id TEXT NOT NULL,
  action_id TEXT NOT NULL, product_id TEXT NOT NULL,
  resource_revision INTEGER NOT NULL CHECK(resource_revision BETWEEN 0 AND 9007199254740991),
  behavior_hash TEXT NOT NULL CHECK(length(behavior_hash)=64),
  issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at>issued_at),
  consumed_at INTEGER,
  CHECK(consumed_at IS NULL OR (consumed_at>=issued_at AND consumed_at<expires_at)),
  FOREIGN KEY(tenant_id,subject_id) REFERENCES memberships(tenant_id,subject_id)
) STRICT;
CREATE INDEX intents_owner ON form_intents(tenant_id,subject_id,action_id,expires_at);
CREATE TABLE order_drafts (
  id TEXT PRIMARY KEY,
  -- Intentionally no FK to temporary form_intents: cleanup must retain business records.
  intent_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL, subject_id TEXT NOT NULL,
  product_id TEXT NOT NULL, product_revision INTEGER NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 20),
  total_minor INTEGER NOT NULL CHECK(total_minor BETWEEN 0 AND 9007199254740991),
  currency TEXT NOT NULL CHECK(currency='KRW'), state TEXT NOT NULL CHECK(state='draft'),
  UNIQUE(id,intent_id),
  FOREIGN KEY (tenant_id,product_id) REFERENCES products(tenant_id,id),
  FOREIGN KEY (tenant_id,subject_id) REFERENCES memberships(tenant_id,subject_id)
) STRICT;
CREATE TABLE action_results (
  intent_id TEXT PRIMARY KEY REFERENCES form_intents(id) ON DELETE CASCADE,
  behavior_hash TEXT NOT NULL CHECK(length(behavior_hash)=64),
  input_hash TEXT NOT NULL CHECK(length(input_hash)=64),
  draft_id TEXT NOT NULL UNIQUE,
  completed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at>completed_at),
  FOREIGN KEY(draft_id,intent_id) REFERENCES order_drafts(id,intent_id)
) STRICT;
CREATE INDEX results_expiry ON action_results(expires_at);
CREATE TABLE boundary_audit (
  id INTEGER PRIMARY KEY, intent_id TEXT NOT NULL, action_id TEXT NOT NULL,
  outcome TEXT NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE(intent_id,action_id,outcome)
) STRICT;
