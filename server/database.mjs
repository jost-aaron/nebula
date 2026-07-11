import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const openNebulaDatabase = async (databasePath) => {
  await mkdir(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
  return database;
};

export const applyDomainMigrations = (database, migrations) => {
  database.exec(`CREATE TABLE IF NOT EXISTS nebula_domain_migrations (
    migration_id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  ) STRICT;`);

  for (const migration of migrations) {
    const id = migration.id ?? `${migration.domain}-v${migration.version}`;
    if (database.prepare("SELECT 1 FROM nebula_domain_migrations WHERE migration_id = ?").get(id)) continue;
    database.exec("BEGIN IMMEDIATE");
    try {
      migration.apply(database);
      database.prepare("INSERT INTO nebula_domain_migrations (migration_id, applied_at) VALUES (?, ?)")
        .run(id, new Date().toISOString());
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
};
