CREATE TABLE IF NOT EXISTS material_cases (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  body TEXT NOT NULL,
  UNIQUE(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS material_cases_tenant ON material_cases(tenant_id);
INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(4,datetime('now'));
