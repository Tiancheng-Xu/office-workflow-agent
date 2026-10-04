PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, csrf TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS targets(tenant_id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0));
CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, epoch INTEGER NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(tenant_id,id));
CREATE INDEX IF NOT EXISTS runs_tenant ON runs(tenant_id);
CREATE TABLE IF NOT EXISTS capabilities(token_hash TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, run_id TEXT NOT NULL, revision INTEGER NOT NULL, plan_hash TEXT NOT NULL, target_revision INTEGER NOT NULL, adapter_version TEXT NOT NULL, expires_at INTEGER NOT NULL, FOREIGN KEY(run_id) REFERENCES runs(id));
CREATE TABLE IF NOT EXISTS demands(tenant_id TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, execution_key TEXT NOT NULL UNIQUE, body TEXT NOT NULL, PRIMARY KEY(tenant_id,request_id));
INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(1,datetime('now'));
