CREATE TABLE IF NOT EXISTS resource_budgets(day TEXT NOT NULL,name TEXT NOT NULL,used INTEGER NOT NULL CHECK(used >= 0),PRIMARY KEY(day,name));
INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(2,datetime('now'));
