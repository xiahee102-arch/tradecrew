CREATE TABLE tenants (id TEXT PRIMARY KEY, factory TEXT NOT NULL, category TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE records (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX records_tenant_kind ON records(tenant, kind);
CREATE TABLE audit (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, entity TEXT, detail TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX audit_tenant ON audit(tenant, created_at);
CREATE TABLE jobs (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, agent TEXT NOT NULL, kind TEXT NOT NULL, input TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, available_at TEXT NOT NULL, lease_until TEXT, output TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX jobs_pending ON jobs(status,available_at);
CREATE TABLE usage (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, agent TEXT NOT NULL, model TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cost_micros INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE payment_orders (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, plan TEXT NOT NULL, amount_fen INTEGER NOT NULL, method TEXT NOT NULL, status TEXT NOT NULL, provider_ref TEXT UNIQUE, checkout_url TEXT, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, paid_at TEXT, activation_id TEXT);
CREATE TABLE subscriptions (tenant TEXT PRIMARY KEY, plan TEXT NOT NULL, status TEXT NOT NULL, expires_at TEXT NOT NULL, auto_renew INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
CREATE TABLE channel_events (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, channel TEXT NOT NULL, data TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE channels (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, channel TEXT NOT NULL, account_id TEXT NOT NULL, token_ref TEXT NOT NULL, health TEXT NOT NULL, last_webhook_at TEXT);
CREATE UNIQUE INDEX channels_account ON channels(channel,account_id);
CREATE TABLE dispatches (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, status TEXT NOT NULL, provider_ref TEXT, error TEXT, updated_at TEXT NOT NULL);

CREATE TABLE quota_events (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX quota_events_tenant ON quota_events(tenant,kind,created_at);
