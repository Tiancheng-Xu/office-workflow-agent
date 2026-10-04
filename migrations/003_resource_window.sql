CREATE TABLE IF NOT EXISTS resource_windows(name TEXT PRIMARY KEY,next_allowed_at INTEGER NOT NULL);
INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(3,datetime('now'));
