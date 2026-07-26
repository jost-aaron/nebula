import { createHash } from "node:crypto";
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
    applied_at TEXT NOT NULL,
    migration_hash TEXT
  ) STRICT;`);
  const columns = new Set(database.prepare("PRAGMA table_info(nebula_domain_migrations)").all().map(({ name }) => name));
  if (!columns.has("migration_hash")) database.exec("ALTER TABLE nebula_domain_migrations ADD COLUMN migration_hash TEXT;");

  for (const migration of migrations) {
    const id = migration.id ?? `${migration.domain}-v${migration.version}`;
    const hash = createHash("sha256").update(`${id}\n${migration.apply.toString()}`).digest("hex");
    const applied = database.prepare("SELECT migration_hash FROM nebula_domain_migrations WHERE migration_id = ?").get(id);
    if (applied) {
      if (applied.migration_hash && applied.migration_hash !== hash) {
        throw Object.assign(new Error(`Applied migration ${id} no longer matches its recorded definition.`), { code: "MIGRATION_HASH_MISMATCH" });
      }
      if (!applied.migration_hash) {
        database.prepare("UPDATE nebula_domain_migrations SET migration_hash = ? WHERE migration_id = ?").run(hash, id);
      }
      continue;
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      migration.apply(database);
      database.prepare("INSERT INTO nebula_domain_migrations (migration_id, applied_at, migration_hash) VALUES (?, ?, ?)")
        .run(id, new Date().toISOString(), hash);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
};
