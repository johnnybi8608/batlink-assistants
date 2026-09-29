#!/usr/bin/env -S node --no-warnings=ExperimentalWarning
// Maintenance commands for the personal memory database.
//   node bin/memdb.js init       create the database (if it exists, only migrate the schema)
//   node bin/memdb.js status     schema version, row counts, file size, integrity check
//   node bin/memdb.js reindex    rebuild the full-text search index
//   node bin/memdb.js purge <table> <id> --actor <who>   hard-delete one row (only when the owner explicitly asks):
//                                                        its history and search entries are removed too
//   node bin/memdb.js selftest   build a throw-away in-memory database and test history, append-only tables,
//                                CJK search, hard delete and the service layer (never touches the real database)
//
// Database location: <config.dataDir>/memdb/memory.db (config.json at the repo root, or the file named by
// $AGENTS_CONFIG) — the same database the daemon opens. The owner entity is named after config.owner.name.

import { statSync, existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openMemDb, schemaVersion, purge, rebuildSearch } from '../src/memdb/db.js';
import { MIGRATIONS } from '../src/memdb/schema.js';
import { MemService, MemError } from '../src/memdb/service.js';
import { toolsFor } from '../src/memdb/tools.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cmd = process.argv[2] ?? 'status';

function loadConfig() {
  const path = resolve(process.env.AGENTS_CONFIG ?? join(root, 'config.json'));
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (error) {
    console.error(`Cannot parse ${path}: ${error.message}`);
    process.exit(2);
  }
}

const config = loadConfig();
const DB_PATH = join(resolve(root, config.dataDir ?? './data'), 'memdb', 'memory.db');
const open = () => openMemDb(DB_PATH, { ownerName: config.owner?.name });

function tables(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'search_%' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
}

function status(db) {
  console.log(`Database: ${DB_PATH}`);
  console.log(`Schema version: v${schemaVersion(db)}`);
  if (existsSync(DB_PATH)) console.log(`File size: ${(statSync(DB_PATH).size / 1024).toFixed(0)} KB`);
  console.log(`Integrity check: ${db.prepare('PRAGMA integrity_check').get().integrity_check}`);
  for (const t of tables(db)) console.log(`  ${t.padEnd(20)} ${db.prepare(`SELECT count(*) n FROM ${t}`).get().n}`);
}

function selftest() {
  const db = openMemDb(':memory:', { ownerName: 'Alex' });
  const ok = (cond, label) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${label}`); if (!cond) process.exitCode = 1; };
  const base = { recorded_by: 'selftest', origin: 'stated', source_system: 'manual' };
  const APPEND_ONLY = /append-only/;

  // 0. Owner entity named after config.owner.name, generic aliases kept for lookups
  const owner = db.prepare("SELECT name, aliases FROM entities WHERE id = 'owner'").get();
  ok(owner?.name === 'Alex' && JSON.parse(owner.aliases).includes('机主'), 'owner entity uses the configured name');

  // 1. Medication: insert, update -> old value lands in history
  const medId = randomUUID();
  db.prepare(`INSERT INTO medications (id, person_id, name, dose, frequency, purpose, started_on, scope, recorded_by, origin, source_system)
    VALUES (?, 'owner', '测试药品甲', '10mg', '每天一次', '测试用途', '2026-03-01', 'health', ?, ?, ?)`).run(medId, base.recorded_by, base.origin, base.source_system);
  db.prepare("UPDATE medications SET dose = '20mg', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(medId);
  const hist = db.prepare("SELECT old_json FROM history WHERE tbl='medications' AND row_id=?").all(medId);
  ok(hist.length === 1 && JSON.parse(hist[0].old_json).dose === '10mg', 'after a dose change the old dose (10mg) is kept in history');

  // 2. Facts: the new one supersedes the old one
  const f1 = randomUUID();
  const f2 = randomUUID();
  const addFact = db.prepare(`INSERT INTO facts (id, entity_id, category, property, value, valid_from, supersedes_id, scope, recorded_by, origin, source_system)
    VALUES (?, 'owner', 'preference', '回复语言', ?, ?, ?, 'work', ?, ?, ?)`);
  addFact.run(f1, '中文', '2026-01-01', null, base.recorded_by, base.origin, base.source_system);
  addFact.run(f2, '中文和英文', '2026-02-01', f1, base.recorded_by, base.origin, base.source_system);
  db.prepare("UPDATE facts SET status = 'superseded' WHERE id = ?").run(f1);
  const current = db.prepare("SELECT value FROM facts WHERE entity_id='owner' AND property='回复语言' AND status='active'").all();
  ok(current.length === 1 && current[0].value.includes('英文'), 'after a preference changes only the new one is active');

  // 3. Events are append-only
  const evId = randomUUID();
  db.prepare(`INSERT INTO events (id, kind, title, body, stage, occurred_at, scope, recorded_by, origin, source_system)
    VALUES (?, 'change', '资料库自检', '测试工作流水', 'deployed', '2026-01-01T01:00:00Z', 'work', ?, 'evidence', 'desktop')`).run(evId, base.recorded_by);
  let blocked = false;
  try { db.prepare("UPDATE events SET title = 'x' WHERE id = ?").run(evId); } catch (e) { blocked = APPEND_ONLY.test(e.message); }
  ok(blocked, 'events cannot be updated');
  blocked = false;
  try { db.prepare('DELETE FROM events WHERE id = ?').run(evId); } catch (e) { blocked = APPEND_ONLY.test(e.message); }
  ok(blocked, 'events cannot be deleted normally');

  // 4. CJK search
  const hit = (q) => db.prepare('SELECT tbl FROM search WHERE search MATCH ?').all(`"${q}"`).map((r) => r.tbl);
  ok(hit('测试药').includes('medications'), 'search "测试药" finds the medication');
  ok(hit('资料库自检').includes('events'), 'search "资料库自检" finds the event');
  ok(db.prepare("SELECT tbl FROM search WHERE body LIKE '%用途%'").all().some((r) => r.tbl === 'medications'), 'two-character term "用途" found with LIKE');
  ok(!hit('10mg').length && hit('20mg').includes('medications'), 'search index follows the dose change');

  // 5. Write permissions
  const can = (role, scope) => !!db.prepare('SELECT 1 FROM write_permissions WHERE role=? AND scope=?').get(role, scope);
  ok(can('chat', 'health') && !can('chat', 'work') && can('project', 'work') && !can('project', 'health') && can('assistant', 'finance'),
    'write permissions: chat writes personal but not work, project writes only work, assistant writes everything');
  ok(can('family', 'finance') && can('family-assistant', 'health') && !can('family-assistant', 'work') && !can('family-assistant', 'infra'),
    'write permissions: family writes everything, family-assistant writes personal scopes only');

  // 6. Hard delete: row, history and search entries all gone, access log keeps only the id
  ok(purge(db, 'medications', medId, 'owner'), 'purge succeeds');
  ok(!db.prepare('SELECT 1 FROM medications WHERE id=?').get(medId), '  medication row gone');
  ok(!db.prepare("SELECT 1 FROM history WHERE tbl='medications' AND row_id=?").get(medId), '  history versions gone');
  ok(!hit('测试药').length, '  no longer searchable');
  const log = db.prepare("SELECT * FROM access_log WHERE action='purge'").get();
  ok(log && log.row_id === medId && !log.detail, '  access log records only who purged which id');
  ok(purge(db, 'events', evId, 'owner'), 'events can be deleted by purge');
  blocked = false;
  try { db.prepare('DELETE FROM access_log').run(); } catch (e) { blocked = APPEND_ONLY.test(e.message); }
  ok(blocked, 'access log can never be deleted');

  // 7. Service layer: remember, family said_by, reminders, search, role restrictions
  const filesDir = mkdtempSync(join(tmpdir(), 'memdb-selftest-'));
  try {
    const mem = new MemService(db, { filesDir, timezone: 'UTC' });
    const lingxi = { actor: 'lingxi', role: 'chat' };
    const fact = mem.call(lingxi, 'mem_remember', { category: 'preference', property: '饮品', value: '喜欢喝绿茶', scope: 'life', origin: 'stated', said_by: 'family' });
    ok(fact.status === 'active' && db.prepare('SELECT stated_by FROM facts WHERE id = ?').get(fact.id)?.stated_by === 'family', 'mem_remember stores said_by=family');
    const found = mem.call(lingxi, 'mem_search', { query: '绿茶' });
    ok(found.results.some((r) => r.id === fact.id), 'mem_search finds the remembered fact');
    const future = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const rem = mem.call(lingxi, 'mem_reminder_add', { title: '喝水', at: `${future} 08:00`, repeat: { freq: 'day' } });
    ok(rem.id && rem.timezone === 'UTC', 'mem_reminder_add uses the configured default time zone');
    ok(mem.call(lingxi, 'mem_reminder_list', {}).count === 1, 'mem_reminder_list shows it');
    let denied = false;
    try { mem.call({ actor: 'someone@dm', role: 'assistant' }, 'mem_reminder_list', {}); } catch (e) { denied = e instanceof MemError; }
    ok(denied, 'reminder tools refused for an assistant without reminders enabled');
    ok(mem.call({ actor: 'helper', role: 'chat', reminders: true }, 'mem_reminder_list', {}).count === 0, 'reminder tools allowed with the --reminders identity flag');
    ok(!toolsFor('someone@dm', 'assistant').some((t) => t.name.startsWith('mem_reminder_')) && toolsFor('helper', 'chat', { reminders: true }).some((t) => t.name === 'mem_reminder_add'),
      'toolsFor lists reminder tools only when allowed');
    const work = mem.call({ actor: 'desktop', role: 'desktop' }, 'mem_log', { kind: 'note', title: '自检工作记录', project: 'demo' });
    const famAssist = { actor: 'helper2', role: 'family-assistant' };
    ok(!mem.call(famAssist, 'mem_search', { query: '自检工作记录' }).results.some((r) => r.id === work.id), 'family-assistant cannot read work entries');
    ok(!toolsFor('helper2', 'family-assistant').some((t) => t.name === 'mem_servers'), 'family-assistant does not see server tools');
    // A restricted role must not replace, edit or read (through history) a record in a scope it cannot see
    const denies = (fn) => { try { fn(); return false; } catch (e) { return e instanceof MemError; } };
    const desk = { actor: 'desktop', role: 'desktop' };
    mem.call(desk, 'mem_remember', { category: 'decision', property: '自检报价', value: '工作机密', scope: 'work', origin: 'stated' });
    ok(denies(() => mem.call(famAssist, 'mem_remember', { category: 'other', property: '自检报价', value: 'x', scope: 'life', origin: 'stated' })),
      'family-assistant cannot supersede a work fact with a life one');
    const srv = mem.call(desk, 'mem_entity', { type: 'server', name: '自检服务器', scope: 'infra', origin: 'stated' });
    ok(denies(() => mem.call(famAssist, 'mem_entity', { id: srv.id, scope: 'life', summary: 'x' })), 'family-assistant cannot edit an infra entity');
    ok(denies(() => mem.call(famAssist, 'mem_entity', { type: 'server', name: '自检服务器', scope: 'life', origin: 'stated' })), 'family-assistant cannot probe an infra entity by name');
    ok(denies(() => mem.call(famAssist, 'mem_history', { table: 'events', id: work.id })), 'family-assistant cannot read the history of a work entry');
  } finally {
    rmSync(filesDir, { recursive: true, force: true });
  }

  ok(schemaVersion(db) === MIGRATIONS.length, `schema version v${MIGRATIONS.length}`);
  console.log(process.exitCode ? '\nSome checks failed' : '\nAll checks passed');
}

if (cmd === 'selftest') selftest();
else if (cmd === 'purge') {
  const [table, id] = [process.argv[3], process.argv[4]];
  const actor = process.argv.includes('--actor') ? process.argv[process.argv.indexOf('--actor') + 1] : 'owner';
  if (!table || !id) { console.error('Usage: node bin/memdb.js purge <table> <id> --actor <who>'); process.exit(2); }
  const db = open();
  const done = purge(db, table, id, actor);
  console.log(done ? `Purged ${table} ${id} (history and search entries removed too; external backups keep it until they expire)` : `Not found: ${table} ${id}`);
  db.close();
}
else if (cmd === 'reindex') {
  const db = open();
  rebuildSearch(db);
  console.log(`Search index rebuilt: ${db.prepare('SELECT count(*) n FROM search').get().n} entries`);
  db.close();
}
else if (cmd === 'init' || cmd === 'status') {
  const existed = existsSync(DB_PATH);
  const db = open();
  if (cmd === 'init') console.log(existed ? 'Database already exists; schema is up to date.' : 'Database created.');
  status(db);
  db.close();
} else {
  console.error('Usage: node bin/memdb.js init | status | reindex | purge <table> <id> | selftest');
  process.exit(2);
}
