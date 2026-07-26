import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { applyDomainMigrations } from "../server/database.mjs";

test("domain migrations are idempotent and reject changed applied definitions", () => {
  const database = new DatabaseSync(":memory:");
  const original = {
    id: "example-v1",
    apply: (db) => db.exec("CREATE TABLE example (id TEXT PRIMARY KEY) STRICT;")
  };
  applyDomainMigrations(database, [original]);
  applyDomainMigrations(database, [original]);
  const recorded = database.prepare("SELECT migration_hash FROM nebula_domain_migrations WHERE migration_id = ?").get(original.id);
  assert.match(recorded.migration_hash, /^[a-f0-9]{64}$/);

  assert.throws(() => applyDomainMigrations(database, [{
    id: original.id,
    apply: (db) => db.exec("CREATE TABLE changed (id TEXT PRIMARY KEY) STRICT;")
  }]), { code: "MIGRATION_HASH_MISMATCH" });
  database.close();
});

test("legacy migration records receive a checksum without being reapplied", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE nebula_domain_migrations (
    migration_id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  ) STRICT;
  INSERT INTO nebula_domain_migrations VALUES ('legacy-v1', '2026-01-01T00:00:00.000Z');`);
  let applied = false;
  applyDomainMigrations(database, [{ id: "legacy-v1", apply: () => { applied = true; } }]);
  assert.equal(applied, false);
  assert.match(database.prepare("SELECT migration_hash FROM nebula_domain_migrations").get().migration_hash, /^[a-f0-9]{64}$/);
  database.close();
});

