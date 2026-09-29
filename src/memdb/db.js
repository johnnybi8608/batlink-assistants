// Personal memory database: open, create / migrate, maintain triggers, hard delete.
// Uses Node's built-in node:sqlite (no dependency). The read/write API lives in service.js on top of this.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATIONS, TRACKED_TABLES, APPEND_ONLY_TABLES, SEARCH_SOURCES, OWNER_ALIASES } from './schema.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_DB_PATH = join(root, 'data', 'memdb', 'memory.db');
/** Name given to the owner entity when config.owner.name is not set */
export const DEFAULT_OWNER_NAME = '主人';

/**
 * Open the database; create it if missing, migrate it if older.
 * @param {string} path  file path or ':memory:'
 * @param {{ ownerName?: string }} options  ownerName = config.owner.name, used only when the database is created
 */
export function openMemDb(path = DEFAULT_DB_PATH, { ownerName } = {}) {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(path), 0o700);
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  migrate(db, ownerName);
  if (path !== ':memory:') {
    for (const f of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(f)) chmodSync(f, 0o600);
  }
  return db;
}

export function schemaVersion(db) {
  const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").get();
  if (!hasMeta) return 0;
  return Number(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value ?? 0);
}

function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** The owner entity always has id 'owner'; its display name comes from config.owner.name */
function seedOwner(db, ownerName) {
  const name = String(ownerName ?? '').trim() || DEFAULT_OWNER_NAME;
  const aliases = OWNER_ALIASES.filter((a) => a !== name);
  db.prepare(`INSERT OR IGNORE INTO entities (id, type, name, aliases, summary, scope, recorded_by, origin, source_system)
    VALUES ('owner', 'person', ?, ?, '资料库的主人', 'personal', 'import', 'stated', 'manual')`).run(name, JSON.stringify(aliases));
}

function migrate(db, ownerName) {
  const current = schemaVersion(db);
  if (current > MIGRATIONS.length) {
    throw new Error(`memdb schema v${current} is newer than this code knows (v${MIGRATIONS.length}); refusing to open it. Use a database created by batlink-assistants.`);
  }
  for (let v = current + 1; v <= MIGRATIONS.length; v += 1) {
    transaction(db, () => {
      db.exec(MIGRATIONS[v - 1]);
      if (v === 1) seedOwner(db, ownerName);
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(v));
    });
  }
  // Triggers are generated from the current columns and rebuilt on every open (new columns are never missed)
  transaction(db, () => installTriggers(db));
  // Rows inserted by migrations predate the triggers, so rebuild the search index once after migrating
  if (current < MIGRATIONS.length) rebuildSearch(db);
}

/** Rebuild the whole search index */
export function rebuildSearch(db) {
  transaction(db, () => {
    db.exec('DELETE FROM search');
    for (const [t, { pk, body }] of Object.entries(SEARCH_SOURCES)) {
      db.exec(`INSERT INTO search (tbl, row_id, body) SELECT '${t}', ${pk}, ${body} FROM ${t}`);
    }
  });
}

const columnsOf = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
const pkOf = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().find((c) => c.pk === 1)?.name ?? 'id';

function installTriggers(db) {
  const existing = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'mem\\_%' ESCAPE '\\'").all();
  for (const { name } of existing) db.exec(`DROP TRIGGER ${name}`);

  // Old values go into history before update / delete
  for (const t of TRACKED_TABLES) {
    const pk = pkOf(db, t);
    const oldJson = `json_object(${columnsOf(db, t).map((c) => `'${c}', OLD.${c}`).join(', ')})`;
    db.exec(`CREATE TRIGGER mem_${t}_hist_upd AFTER UPDATE ON ${t} BEGIN
      INSERT INTO history (tbl, row_id, op, old_json) VALUES ('${t}', OLD.${pk}, 'update', ${oldJson}); END`);
    db.exec(`CREATE TRIGGER mem_${t}_hist_del AFTER DELETE ON ${t}
      WHEN (SELECT value FROM meta WHERE key='purging') IS NOT '1' BEGIN
      INSERT INTO history (tbl, row_id, op, old_json) VALUES ('${t}', OLD.${pk}, 'delete', ${oldJson}); END`);
  }

  // Append-only: never updated; deletes only allowed during purge, and access_log is never deleted
  for (const t of APPEND_ONLY_TABLES) {
    db.exec(`CREATE TRIGGER mem_${t}_no_upd BEFORE UPDATE ON ${t} BEGIN SELECT RAISE(ABORT, '${t} is append-only: updates are not allowed'); END`);
    const when = t === 'access_log' ? '' : `WHEN (SELECT value FROM meta WHERE key='purging') IS NOT '1'`;
    db.exec(`CREATE TRIGGER mem_${t}_no_del BEFORE DELETE ON ${t} ${when} BEGIN SELECT RAISE(ABORT, '${t} is append-only: deletes are not allowed'); END`);
  }

  // Keep the full-text index in sync with the business tables
  for (const [t, { pk, body }] of Object.entries(SEARCH_SOURCES)) {
    const insert = `INSERT INTO search (tbl, row_id, body) SELECT '${t}', ${pk}, ${body} FROM ${t} WHERE ${pk} = NEW.${pk};`;
    db.exec(`CREATE TRIGGER mem_${t}_fts_ins AFTER INSERT ON ${t} BEGIN ${insert} END`);
    db.exec(`CREATE TRIGGER mem_${t}_fts_upd AFTER UPDATE ON ${t} BEGIN
      DELETE FROM search WHERE tbl = '${t}' AND row_id = OLD.${pk}; ${insert} END`);
    db.exec(`CREATE TRIGGER mem_${t}_fts_del AFTER DELETE ON ${t} BEGIN
      DELETE FROM search WHERE tbl = '${t}' AND row_id = OLD.${pk}; END`);
  }
}

/**
 * Hard delete (only when the owner explicitly asks): removes the row together with its history and search entries.
 * access_log keeps only "who hard-deleted which id of which table, and when" — no content.
 * Note: any external backups of the database file still contain the row until they expire.
 */
export function purge(db, table, id, actor) {
  if (![...TRACKED_TABLES, 'events'].includes(table)) throw new Error(`Cannot purge table ${table}`);
  const pk = table === 'events' ? 'id' : pkOf(db, table);
  return transaction(db, () => {
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('purging', '1')").run();
    try {
      // Detach rows pointing at it through supersedes_id first (the foreign key would block the delete)
      if (columnsOf(db, table).includes('supersedes_id')) {
        db.prepare(`UPDATE ${table} SET supersedes_id = NULL WHERE supersedes_id = ?`).run(id);
      }
      const { changes } = db.prepare(`DELETE FROM ${table} WHERE ${pk} = ?`).run(id);
      db.prepare('DELETE FROM history WHERE tbl = ? AND row_id = ?').run(table, id);
      db.prepare('DELETE FROM search WHERE tbl = ? AND row_id = ?').run(table, id);
      db.prepare("INSERT INTO access_log (actor, action, tbl, row_id, ok) VALUES (?, 'purge', ?, ?, ?)").run(actor, table, id, changes ? 1 : 0);
      return changes > 0;
    } finally {
      db.prepare("DELETE FROM meta WHERE key = 'purging'").run();
    }
  });
}
