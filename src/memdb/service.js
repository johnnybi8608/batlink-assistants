// Memory read/write service: every AI query and write goes through here (called inside the bot main process).
//
// Permissions:
//   - The caller identity (actor / role / project) is fixed by the MCP bridge's launch arguments; the AI cannot change it.
//   - Which scopes a role may write comes from the write_permissions table (role x scope); a project-group bot may
//     only log events for its own project.
//   - Reads are open, except the scopes in READ_DENY for restricted roles.
// Provenance rules:
//   - origin=inferred (AI guess) is always stored as 'unverified'; a guess that contradicts what the owner stated
//     is stored as 'conflict' and does not replace it.
//   - A newer statement about the same property replaces the old one; but one with an earlier valid_from
//     (back-filling the past) does not override the newer one.
//   - Writes with a source_ref are de-duplicated by identity + tool + arguments.
// Every call is written to access_log: who, which tool, success, argument names and record ids — never content.
//
// Error messages (MemError) are returned verbatim to the AI; result hints ("note") are Chinese prompts for the AI.

import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { TOOL_BY_NAME, HIDDEN_FOR_ROLE, canUseTool } from './tools.js';
import { TRACKED_TABLES } from './schema.js';
import { DEFAULT_TIMEZONE, setDefaultTimezone, isValidTimezone, parseLocal, formatLocal, occurrence, nextOccurrenceAfter, describeRule } from './recurrence.js';

// Reminders: wake the assistant when due, then every 20 minutes until done, at most 20 times
export const REMINDER_INTERVAL_MS = 20 * 60 * 1000;
export const REMINDER_MAX_PUSHES = 20;

export class MemError extends Error {}

// owner = the owner in person / family = a family member in person / desktop = the owner's desktop AI sessions /
// assistant = DM assistant / project = project-group bot / chat = restricted personal assistant /
// import = bulk import / family-assistant = assistant serving a family member
const ROLES = ['owner', 'family', 'desktop', 'assistant', 'project', 'chat', 'import', 'family-assistant'];
/** Scopes these roles cannot read (an assistant serving a family member sees no work, servers, customers or billing) */
const READ_DENY = { 'family-assistant': new Set(['work', 'infra', 'finance']) };
const SOURCE_SYSTEM = { chat: 'batlink-group', project: 'batlink-group', assistant: 'batlink-dm', desktop: 'desktop', owner: 'manual', family: 'manual', import: 'import', 'family-assistant': 'batlink-dm' };
const CURRENT = "('active','unverified','conflict')";
const nowIso = () => new Date().toISOString();
const today = () => new Date().toLocaleDateString('sv-SE'); // local date YYYY-MM-DD
const fail = (msg) => { throw new MemError(msg); };

function checkDate(value, label) {
  if (value != null && !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(`${label} must be formatted as YYYY-MM-DD`);
  return value ?? null;
}

/** Advance a date by one billing cycle */
function advance(date, cycle) {
  const months = { monthly: 1, quarterly: 3, 'half-yearly': 6, yearly: 12 }[cycle];
  if (!months) return date;
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last));
  return t.toISOString().slice(0, 10);
}

/** Drop empty and internal fields before showing a row to the AI */
function clean(row) {
  if (!row) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (v == null || k === 'idem_key' || k === 'source_system' || k === 'updated_at') continue;
    out[k] = k === 'aliases' ? JSON.parse(v) : v;
  }
  return out;
}

export class MemService {
  /**
   * @param {import('node:sqlite').DatabaseSync} db  from openMemDb()
   * @param {{ filesDir: string, timezone?: string }} options
   *   filesDir: where original files (e.g. health report images) are copied;
   *   timezone: default reminder time zone = config.owner.timezone (empty = system time zone)
   */
  constructor(db, { filesDir, timezone } = {}) {
    this.db = db;
    this.filesDir = filesDir;
    if (timezone !== undefined) {
      // An invalid time zone must not take the whole database down: warn and use the system zone
      try { new Intl.DateTimeFormat('en', { timeZone: timezone || undefined }); setDefaultTimezone(timezone); }
      catch { console.error(`memdb: invalid time zone "${timezone}", using the system time zone`); setDefaultTimezone(''); }
    }
  }

  /** Run a tool and return the result object for the AI. Throws MemError on failure (its text is shown to the AI) */
  call(identity, tool, args = {}) {
    const def = TOOL_BY_NAME[tool];
    if (!def) fail(`Unknown tool: ${tool}`);
    const who = this.#identity(identity);
    if (HIDDEN_FOR_ROLE[who.role]?.has(tool)) fail(`${tool} is not available to your role (${who.role})`);
    if (!canUseTool(def, who)) fail(`${tool} is only available to personal assistants that have reminders enabled`);
    let ok = 1;
    try {
      const handler = this[tool.replace(/^mem_/, 't_')];
      if (!handler) fail(`Tool ${tool} is not implemented`);
      return def.write ? this.#tx(() => handler.call(this, who, args)) : handler.call(this, who, args);
    } catch (error) {
      ok = 0;
      throw error;
    } finally {
      // No content in the log (it would outlive a hard delete): only which arguments were given, and record ids
      const detail = JSON.stringify({ args: Object.keys(args ?? {}), ...(args?.id ? { id: String(args.id).slice(0, 64) } : {}), ...(args?.table ? { table: String(args.table).slice(0, 32) } : {}) });
      this.db.prepare('INSERT INTO access_log (actor, action, tbl, ok, detail) VALUES (?, ?, ?, ?, ?)')
        .run(who.actor, def.write ? 'write' : 'read', tool, ok, detail);
    }
  }

  // ── Internal helpers ─────────────────────────────────────

  #identity(identity) {
    const actor = String(identity?.actor ?? '').trim();
    const role = String(identity?.role ?? '').trim();
    if (!actor || !ROLES.includes(role)) fail('Invalid identity: the MCP bridge was started without a valid actor or role');
    if (role === 'project' && !identity.project) fail('Project-group bot identity is missing its project');
    // self: the person this assistant serves (what "默认你的主人本人" means in the tool descriptions);
    // defaults to the owner, an assistant serving a family member passes that person's name or id.
    // reminders: set by the MCP bridge's --reminders flag (see tools.js canUseTool)
    return { actor, role, project: identity.project ?? null, self: identity.self ?? 'owner', reminders: identity.reminders === true };
  }

  #tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * An existing record may only be replaced, edited or retracted by someone who can both READ and WRITE its scope.
   * Checking only the new record's scope would let a restricted role overwrite (and, through the reply, read) a record
   * it cannot see — e.g. a family assistant superseding a work fact with a "life" one.
   */
  #mayTouch(who, scope, what = 'record') {
    if (!this.#canRead(who, scope)) fail(`Permission denied: this ${what} is in a scope your role cannot read`);
    this.#canWrite(who, scope);
  }

  #canWrite(who, scope) {
    if (!scope) fail('Missing scope');
    if (!this.db.prepare('SELECT 1 FROM scopes WHERE name = ?').get(scope)) fail(`Unknown scope: ${scope}`);
    if (!this.db.prepare('SELECT 1 FROM write_permissions WHERE role = ? AND scope = ?').get(who.role, scope)) {
      const label = this.db.prepare('SELECT label FROM scopes WHERE name = ?').get(scope).label;
      fail(`Permission denied: ${who.actor} cannot write the ${scope} (${label}) scope`);
    }
  }

  /** Find by id / name / alias; several matches is an error so the AI has to disambiguate */
  #find(ref, type = null) {
    if (ref == null || String(ref).trim() === '') return null;
    const r = String(ref).trim();
    const rows = this.db.prepare(`SELECT * FROM entities WHERE status = 'active' AND (? IS NULL OR type = ?)
      AND (id = ? OR lower(name) = lower(?) OR EXISTS (SELECT 1 FROM json_each(entities.aliases) WHERE lower(json_each.value) = lower(?)))`)
      .all(type, type, r, r, r);
    if (rows.length > 1) fail(`"${r}" matches several entries: ${rows.map((e) => `${e.name} (${e.type}, id ${e.id})`).join('; ')}. Use the id instead`);
    return rows[0] ?? null;
  }

  #mustFind(ref, type = null, hint = '') {
    const e = this.#find(ref, type);
    if (!e) fail(`"${ref}" is not in the database${hint || '; register it with mem_entity first if needed'}`);
    return e;
  }

  #prov(who, args, scope, tool) {
    const idem = args.source_ref ? createHash('sha256').update(`${who.actor}|${tool}|${JSON.stringify(args)}`).digest('hex') : null;
    return {
      scope,
      recorded_by: who.actor,
      origin: args.origin ?? 'stated',
      source_system: SOURCE_SYSTEM[who.role],
      source_ref: args.source_ref ?? null,
      idem_key: idem,
      stated_by: args.said_by ?? null
    };
  }

  #dup(table, prov) {
    if (!prov.idem_key) return null;
    const pk = table === 'servers' || table === 'customers' ? 'entity_id' : 'id';
    return this.db.prepare(`SELECT ${pk} AS id FROM ${table} WHERE idem_key = ?`).get(prov.idem_key)?.id ?? null;
  }

  #insert(table, row) {
    const cols = Object.keys(row).filter((k) => row[k] !== undefined);
    this.db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c]));
    return row;
  }

  #update(table, pk, id, patch) {
    const cols = Object.keys(patch).filter((k) => patch[k] !== undefined);
    if (!cols.length) return 0;
    const sql = `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE ${pk} = ?`;
    return this.db.prepare(sql).run(...cols.map((c) => patch[c]), nowIso(), id).changes;
  }

  /** Create an entity (internal: servers, customers and projects are created on demand) */
  #newEntity(who, type, name, scope, extra = {}) {
    const id = randomUUID();
    this.#insert('entities', { id, type, name, aliases: JSON.stringify(extra.aliases ?? []), summary: extra.summary ?? null, note: extra.note ?? null, ...this.#prov(who, extra, scope, 'entity') });
    return this.db.prepare('SELECT * FROM entities WHERE id = ?').get(id);
  }

  #project(who, name) {
    if (who.role === 'project') name = who.project;
    if (!name) return null;
    return this.#find(name, 'project') ?? this.#newEntity({ ...who, role: 'import' }, 'project', name, 'work');
  }

  /** Whether this identity may read this scope */
  #canRead(who, scope) {
    return !READ_DENY[who.role]?.has(scope);
  }

  #selfEntity(who) {
    return this.#mustFind(who.self, 'person');
  }

  #nameOf(id) {
    return id ? this.db.prepare('SELECT name FROM entities WHERE id = ?').get(id)?.name ?? id : null;
  }

  /**
   * Family roster (inserted into assistant prompts by the program; not an AI tool): the owner's family,
   * labelled from the point of view of selfRef. Labels are derived from the relations (spouse / child / parent /
   * sibling) and each person's '性别' fact (e.g. 本人 / 配偶 / 孩子 / 父母 from the point of view of whoever selfRef is).
   * Labels are Chinese because they go into Chinese prompts.
   */
  family(selfRef = 'owner') {
    const LABEL = { spouse: { 女: '妻子', 男: '丈夫', _: '配偶' }, child: { 女: '女儿', 男: '儿子', _: '孩子' }, parent: { 女: '妈妈', 男: '爸爸', _: '父母' }, sibling: { _: '兄弟姐妹' } };
    const fact = (id, property) => this.db.prepare("SELECT value FROM facts WHERE entity_id = ? AND property = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1").get(id, property)?.value ?? null;
    const labelOf = (rel, gender) => LABEL[rel][gender] ?? LABEL[rel]._;
    const owner = this.db.prepare("SELECT * FROM entities WHERE id = 'owner'").get();
    const self = this.#find(selfRef, 'person') ?? owner;
    const members = [{ e: owner, rel: 'self' }, ...this.db.prepare(`SELECT e.*, r.type AS rel FROM relations r JOIN entities e ON e.id = r.to_id
      WHERE r.from_id = 'owner' AND r.status = 'active' AND r.type IN ('spouse','child','parent','sibling') AND e.status = 'active' ORDER BY r.type, e.name`)
      .all().map((e) => ({ e, rel: e.rel }))];
    const selfRel = members.find((m) => m.e.id === self.id)?.rel ?? 'self';
    const selfGender = fact(self.id, '性别');
    const relation = ({ e, rel }) => {
      if (e.id === self.id) return '本人';
      const gender = fact(e.id, '性别');
      if (selfRel === 'self') return labelOf(rel, gender);             // from the owner's point of view
      if (rel === 'self') return selfRel === 'spouse' ? (selfGender === '女' ? '丈夫' : selfGender === '男' ? '妻子' : '配偶') : `家里的${e.name}`;
      if (selfRel === 'spouse' && rel === 'child') return labelOf('child', gender); // from the spouse's view children are still son / daughter
      if (selfRel === 'spouse') return `${selfGender === '女' ? '丈夫' : selfGender === '男' ? '妻子' : '配偶'}的${labelOf(rel, gender)}`;
      return labelOf(rel, gender);
    };
    const about = (id) => {
      const age = fact(id, '年龄')?.match(/(\d{1,3})\s*岁/)?.[1];
      return [age && `${age} 岁`, fact(id, '职业')].filter(Boolean).join(',') || null;
    };
    const out = members.map((m) => ({ name: m.e.name, relation: relation(m), aliases: JSON.parse(m.e.aliases), birthday: fact(m.e.id, '生日'), about: about(m.e.id) }));
    return [...out.filter((x) => x.relation === '本人'), ...out.filter((x) => x.relation !== '本人')];
  }

  // ── Queries ──────────────────────────────────────────────

  t_search(who, { query, scope, limit = 20 }) {
    const q = String(query ?? '').trim();
    if (!q) fail('query must not be empty');
    const max = Math.min(Number(limit) || 20, 100);
    // Every whitespace-separated term must match (any order); terms of 3+ characters use the trigram index, shorter ones LIKE
    const terms = q.split(/\s+/).filter(Boolean);
    const long = terms.filter((t) => [...t].length >= 3);
    const short = terms.filter((t) => [...t].length < 3);
    const like = short.map(() => "body LIKE ? ESCAPE '\\'").join(' AND ');
    const likeArgs = short.map((t) => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    const rows = long.length
      ? this.db.prepare(`SELECT tbl, row_id, body FROM search WHERE search MATCH ?${like ? ` AND ${like}` : ''} LIMIT ?`)
        .all(long.map((t) => `"${t.replace(/"/g, '""')}"`).join(' AND '), ...likeArgs, max * 3)
      : this.db.prepare(`SELECT tbl, row_id, body FROM search WHERE ${like} LIMIT ?`).all(...likeArgs, max * 3);
    const out = [];
    for (const r of rows) {
      const pk = r.tbl === 'servers' || r.tbl === 'customers' ? 'entity_id' : 'id';
      const row = this.db.prepare(`SELECT * FROM ${r.tbl} WHERE ${pk} = ?`).get(r.row_id);
      if (!row || (scope && row.scope !== scope) || !this.#canRead(who, row.scope)) continue;
      out.push({ table: r.tbl, id: r.row_id, scope: row.scope, status: row.status, text: r.body.slice(0, 300) });
      if (out.length >= max) break;
    }
    return { count: out.length, results: out };
  }

  t_get(who, { name }) {
    const e = name ? this.#mustFind(name) : this.#selfEntity(who);
    if (!this.#canRead(who, e.scope)) fail(`"${e.name}" is in the ${e.scope} scope, which your role cannot read`);
    const readable = (row) => this.#canRead(who, row.scope);
    const facts = this.db.prepare(`SELECT id, category, property, value, valid_from, status, origin, stated_by, recorded_by, created_at, scope FROM facts
      WHERE entity_id = ? AND status IN ${CURRENT} ORDER BY category, property`).all(e.id).filter(readable).map(clean);
    const relations = [
      ...this.db.prepare(`SELECT id, type, to_id AS other, status, scope FROM relations WHERE from_id = ? AND status IN ${CURRENT}`).all(e.id).filter(readable)
        .map((r) => ({ id: r.id, relation: `${e.name} ${r.type} ${this.#nameOf(r.other)}`, status: r.status })),
      ...this.db.prepare(`SELECT id, type, from_id AS other, status, scope FROM relations WHERE to_id = ? AND status IN ${CURRENT}`).all(e.id).filter(readable)
        .map((r) => ({ id: r.id, relation: `${this.#nameOf(r.other)} ${r.type} ${e.name}`, status: r.status }))
    ];
    const out = { entity: clean(e), facts, relations };
    if (e.type === 'person') {
      out.medications = this.db.prepare("SELECT id, name, dose, frequency, purpose, started_on, status FROM medications WHERE person_id = ? AND status != 'stopped'").all(e.id).map(clean);
    }
    if (e.type === 'server') {
      const s = this.db.prepare('SELECT * FROM servers WHERE entity_id = ?').get(e.id);
      if (s) out.server = clean({ ...s, customer: this.#nameOf(s.customer_id), customer_id: undefined });
    }
    if (e.type === 'customer') {
      out.customer = clean(this.db.prepare('SELECT * FROM customers WHERE entity_id = ?').get(e.id));
      out.billing = this.db.prepare('SELECT * FROM billing WHERE customer_id = ?').all(e.id).map(clean);
      out.servers = this.db.prepare('SELECT s.entity_id, x.name, s.ip, s.expires_on, s.status FROM servers s JOIN entities x ON x.id = s.entity_id WHERE s.customer_id = ?').all(e.id).map(clean);
    }
    out.secrets = this.db.prepare('SELECT purpose, username, vault, vault_ref, scope FROM secret_refs WHERE entity_id = ?').all(e.id).filter(readable).map(clean);
    out.recent_events = this.db.prepare('SELECT id, kind, title, stage, occurred_at, recorded_by, scope FROM events WHERE project_id = ? OR entity_id = ? ORDER BY occurred_at DESC LIMIT 30')
      .all(e.id, e.id).filter(readable).slice(0, 10).map(clean);
    return out;
  }

  t_recent(who, { project, days = 7, limit = 30 }) {
    const since = new Date(Date.now() - (Number(days) || 7) * 86400000).toISOString();
    const p = project ? this.#mustFind(project, 'project') : null;
    const rows = this.db.prepare(`SELECT e.id, e.kind, e.title, e.body, e.stage, e.occurred_at, e.recorded_by, e.scope, p.name AS project FROM events e
      LEFT JOIN entities p ON p.id = e.project_id WHERE e.occurred_at >= ? AND (? IS NULL OR e.project_id = ?) ORDER BY e.occurred_at DESC LIMIT ?`)
      .all(since, p?.id ?? null, p?.id ?? null, Math.min(Number(limit) || 30, 200)).filter((r) => this.#canRead(who, r.scope));
    return { since, count: rows.length, events: rows.map((r) => clean({ ...r, body: r.body?.slice(0, 500) })) };
  }

  t_health(who, { person, item }) {
    const p = person ? this.#mustFind(person, 'person') : this.#selfEntity(who);
    const out = {
      person: p.name,
      medications: this.db.prepare("SELECT id, name, dose, frequency, purpose, prescriber, started_on, stopped_on, status FROM medications WHERE person_id = ? ORDER BY status = 'stopped', started_on DESC").all(p.id).map(clean),
      reports: this.db.prepare(`SELECT r.id, r.title, r.kind, r.taken_on, r.institution, r.summary, (SELECT count(*) FROM lab_results l WHERE l.report_id = r.id) AS items
        FROM health_reports r WHERE r.person_id = ? ORDER BY r.taken_on DESC LIMIT 10`).all(p.id).map(clean)
    };
    if (item) {
      out.trend = this.db.prepare(`SELECT item, value_num, value_text, unit, ref_low, ref_high, ref_text, flag, taken_on FROM lab_results
        WHERE person_id = ? AND item LIKE ? ORDER BY item, taken_on`).all(p.id, `%${item}%`).map(clean);
    }
    return out;
  }

  t_servers(who, { expiring_within_days, customer, query }) {
    const c = customer ? this.#mustFind(customer, 'customer') : null;
    const until = expiring_within_days != null ? new Date(Date.now() + Number(expiring_within_days) * 86400000).toLocaleDateString('sv-SE') : null;
    const rows = this.db.prepare(`SELECT x.name, s.*, cu.name AS customer FROM servers s JOIN entities x ON x.id = s.entity_id LEFT JOIN entities cu ON cu.id = s.customer_id
      WHERE (? IS NULL OR s.customer_id = ?) AND (? IS NULL OR (s.status = 'active' AND s.expires_on <= ?))
      AND (? IS NULL OR coalesce(s.ip,'') || ' ' || coalesce(s.purpose,'') || ' ' || coalesce(s.provider,'') || ' ' || x.name LIKE ?)
      ORDER BY s.expires_on IS NULL, s.expires_on`).all(c?.id ?? null, c?.id ?? null, until, until, query ?? null, `%${query ?? ''}%`);
    return { count: rows.length, servers: rows.map((r) => clean({ ...r, customer_id: undefined, secret_ref_id: undefined, origin: undefined, recorded_by: undefined })) };
  }

  t_billing(who, { due_within_days, customer }) {
    const c = customer ? this.#mustFind(customer, 'customer') : null;
    const until = due_within_days != null ? new Date(Date.now() + Number(due_within_days) * 86400000).toLocaleDateString('sv-SE') : null;
    const rows = this.db.prepare(`SELECT b.*, cu.name AS customer, sv.name AS server FROM billing b JOIN entities cu ON cu.id = b.customer_id LEFT JOIN entities sv ON sv.id = b.server_id
      WHERE (? IS NULL OR b.customer_id = ?) AND (? IS NULL OR (b.status = 'active' AND b.next_due_on <= ?)) ORDER BY b.next_due_on IS NULL, b.next_due_on`)
      .all(c?.id ?? null, c?.id ?? null, until, until);
    return { count: rows.length, billing: rows.map((r) => clean({ ...r, customer_id: undefined, server_id: undefined })) };
  }

  t_history(who, { table, id }) {
    if (![...TRACKED_TABLES, 'events'].includes(table)) fail(`Unknown table: ${table}`);
    const pk = table === 'servers' || table === 'customers' ? 'entity_id' : 'id';
    const row = this.db.prepare(`SELECT scope FROM ${table} WHERE ${pk} = ?`).get(id);
    if (row && !this.#canRead(who, row.scope)) fail(`This record is in the ${row.scope} scope, which your role cannot read`);
    // Every old version is checked on its own (a deleted record has no current row to check, and a record's scope
    // may have changed over time): versions in unreadable scopes are withheld.
    const versions = this.db.prepare('SELECT op, old_json, changed_at FROM history WHERE tbl = ? AND row_id = ? ORDER BY seq')
      .all(table, id).map((h) => ({ op: h.op, changed_at: h.changed_at, before: clean(JSON.parse(h.old_json)) }));
    const readable = versions.filter((v) => !v.before?.scope || this.#canRead(who, v.before.scope));
    if (!row && versions.length && !readable.length) fail('This record is in a scope your role cannot read');
    return {
      current: clean(this.db.prepare(`SELECT * FROM ${table} WHERE ${pk} = ?`).get(id)) ?? '(已删除)',
      versions: readable,
      ...(readable.length < versions.length ? { withheld: versions.length - readable.length } : {})
    };
  }

  // ── Writes ───────────────────────────────────────────────

  t_remember(who, args) {
    const e = args.about ? this.#mustFind(args.about) : this.#selfEntity(who);
    if (!this.#canRead(who, e.scope)) fail('Permission denied: that entity is in a scope your role cannot read');
    this.#canWrite(who, args.scope);
    const validFrom = checkDate(args.valid_from, 'valid_from');
    const prov = this.#prov(who, args, args.scope, 'remember');
    const dupId = this.#dup('facts', prov);
    if (dupId) return { id: dupId, duplicate: true };
    const property = String(args.property).trim();
    const value = String(args.value).trim();
    const cur = this.db.prepare(`SELECT * FROM facts WHERE entity_id = ? AND property = ? AND status IN ('active','unverified')
      ORDER BY coalesce(valid_from, created_at) DESC LIMIT 1`).get(e.id, property);
    if (cur) this.#mayTouch(who, cur.scope, 'existing fact');

    if (cur && cur.value === value) {
      if (cur.status === 'unverified' && prov.origin !== 'inferred') {
        this.#update('facts', 'id', cur.id, { status: 'active', origin: prov.origin, stated_by: prov.stated_by, verified_at: nowIso() });
        return { id: cur.id, confirmed: true, note: '原来待核实的这条,现在确认了' };
      }
      return { id: cur.id, unchanged: true };
    }

    let status = 'active';
    let replace = false;
    if (prov.origin === 'inferred') {
      if (cur && cur.origin !== 'inferred') status = 'conflict';
      else { status = 'unverified'; replace = !!cur; }
    } else if (cur && validFrom && cur.valid_from && validFrom < cur.valid_from) {
      status = 'superseded'; // back-filling an earlier state: do not override the current one
    } else {
      replace = !!cur;
    }
    const id = randomUUID();
    this.#insert('facts', {
      id, entity_id: e.id, category: args.category, property, value, valid_from: validFrom,
      status, supersedes_id: replace ? cur.id : null, note: args.note ?? null, ...prov
    });
    if (replace) this.#update('facts', 'id', cur.id, { status: 'superseded' });
    const hint = {
      conflict: `和机主之前说的「${cur?.value}」不一致,已标成"有冲突",没有替代,等机主确认`,
      unverified: '这是推测,已标成"待核实"',
      superseded: `补记的是更早的情况,当前有效的还是「${cur?.value}」`
    }[status];
    return { id, status, ...(replace ? { replaced: cur.value } : {}), ...(hint ? { note: hint } : {}) };
  }

  t_log(who, args) {
    const scope = args.scope ?? 'work';
    this.#canWrite(who, scope);
    const project = this.#project(who, args.project);
    const prov = { ...this.#prov(who, args, scope, 'log'), origin: args.said_by ? 'stated' : 'evidence' };
    const dupId = this.#dup('events', prov);
    if (dupId) return { id: dupId, duplicate: true };
    const title = String(args.title).trim();
    const recent = this.db.prepare(`SELECT id FROM events WHERE title = ? AND recorded_by = ? AND coalesce(project_id,'') = coalesce(?, '')
      AND coalesce(stage,'') = coalesce(?, '') AND created_at >= ?`).get(title, who.actor, project?.id ?? null, args.stage ?? null, new Date(Date.now() - 30 * 60000).toISOString());
    if (recent) return { id: recent.id, duplicate: true, note: '半小时内已经记过同样的一条' };
    const id = randomUUID();
    this.#insert('events', {
      id, kind: args.kind, project_id: project?.id ?? null, title, body: args.body ?? null, stage: args.stage ?? null,
      occurred_at: args.occurred_at ?? nowIso(), ...prov
    });
    return { id, project: project?.name ?? null };
  }

  t_entity(who, args) {
    if (args.id) {
      const e = this.#mustFind(args.id);
      this.#mayTouch(who, e.scope, 'entity');
      if (args.scope) this.#canWrite(who, args.scope);
      this.#update('entities', 'id', e.id, {
        name: args.name, summary: args.summary, note: args.note, type: args.type,
        aliases: args.aliases ? JSON.stringify([...new Set([...JSON.parse(e.aliases), ...args.aliases])]) : undefined
      });
      return { id: e.id, updated: true };
    }
    if (!args.type || !args.name) fail('type and name are required to create an entity');
    this.#canWrite(who, args.scope);
    const existing = this.#find(args.name, args.type);
    if (existing && !this.#canRead(who, existing.scope)) fail('Permission denied: an entity with that name exists in a scope your role cannot read');
    if (existing) return { id: existing.id, existing: true, note: '已经有了,没有重复建;要改就带上 id' };
    const e = this.#newEntity(who, args.type, String(args.name).trim(), args.scope, args);
    return { id: e.id, created: true };
  }

  t_relate(who, args) {
    const from = this.#mustFind(args.from);
    const to = this.#mustFind(args.to);
    if (!this.#canRead(who, from.scope) || !this.#canRead(who, to.scope)) fail('Permission denied: one of those entities is in a scope your role cannot read');
    this.#canWrite(who, args.scope);
    const cur = this.db.prepare(`SELECT id FROM relations WHERE from_id = ? AND type = ? AND to_id = ? AND status IN ${CURRENT}`).get(from.id, args.type, to.id);
    if (cur) return { id: cur.id, unchanged: true };
    const prov = this.#prov(who, args, args.scope, 'relate');
    const id = randomUUID();
    this.#insert('relations', {
      id, from_id: from.id, type: args.type, to_id: to.id, valid_from: checkDate(args.valid_from, 'valid_from'),
      status: prov.origin === 'inferred' ? 'unverified' : 'active', note: args.note ?? null, ...prov
    });
    return { id, relation: `${from.name} ${args.type} ${to.name}` };
  }

  t_medication(who, args) {
    const p = args.person ? this.#mustFind(args.person, 'person') : this.#selfEntity(who);
    this.#canWrite(who, 'health');
    const date = checkDate(args.date, 'date') ?? today();
    const name = String(args.name).trim();
    const cur = this.db.prepare("SELECT * FROM medications WHERE person_id = ? AND lower(name) = lower(?) AND status != 'stopped' ORDER BY started_on DESC LIMIT 1").get(p.id, name);
    const patch = { dose: args.dose, frequency: args.frequency, purpose: args.purpose, prescriber: args.prescriber, note: args.note };
    if (args.action === 'stop') {
      if (!cur) fail(`No current medication "${name}" found for ${p.name}`);
      this.#update('medications', 'id', cur.id, { ...patch, status: 'stopped', stopped_on: date });
      return { id: cur.id, stopped_on: date };
    }
    if (cur) {
      this.#update('medications', 'id', cur.id, { ...patch, status: 'taking' });
      return { id: cur.id, updated: true, note: '旧的剂量/用法留在历史里' };
    }
    if (args.action === 'update') fail(`No current medication "${name}" found for ${p.name}; use action=start for a new one`);
    const id = randomUUID();
    this.#insert('medications', { id, person_id: p.id, name, ...patch, started_on: date, status: 'taking', ...this.#prov(who, args, 'health', 'medication') });
    return { id, started_on: date };
  }

  t_health_report(who, args) {
    const p = args.person ? this.#mustFind(args.person, 'person') : this.#selfEntity(who);
    this.#canWrite(who, 'health');
    const takenOn = checkDate(args.taken_on, 'taken_on');
    const prov = this.#prov(who, args, 'health', 'health_report');
    const dupId = this.#dup('health_reports', prov);
    if (dupId) return { id: dupId, duplicate: true };
    let fileId = null;
    if (args.file_path) {
      if (!existsSync(args.file_path)) fail(`File not found: ${args.file_path}`);
      const data = readFileSync(args.file_path);
      const sha = createHash('sha256').update(data).digest('hex');
      mkdirSync(this.filesDir, { recursive: true, mode: 0o700 });
      const location = join(this.filesDir, `${sha}${extname(args.file_path).toLowerCase()}`);
      if (!existsSync(location)) { writeFileSync(location, data); chmodSync(location, 0o600); }
      fileId = this.db.prepare('SELECT id FROM files WHERE sha256 = ?').get(sha)?.id ?? null;
      if (!fileId) {
        fileId = randomUUID();
        this.#insert('files', { id: fileId, entity_id: p.id, kind: 'health-report', location, sha256: sha, bytes: data.length, encrypted: 0, ...this.#prov(who, {}, 'health', 'file') });
      }
    }
    const id = randomUUID();
    this.#insert('health_reports', {
      id, person_id: p.id, title: args.title, kind: args.kind ?? null, taken_on: takenOn, institution: args.institution ?? null,
      file_id: fileId, summary: args.summary ?? null, ...prov
    });
    for (const r of args.results ?? []) {
      const n = Number(String(r.value).replace(/[<>≤≥↑↓\s]/g, ''));
      this.#insert('lab_results', {
        id: randomUUID(), report_id: id, person_id: p.id, item: String(r.item).trim(),
        value_num: Number.isFinite(n) && String(r.value).trim() !== '' ? n : null, value_text: String(r.value),
        unit: r.unit ?? null, ref_low: r.ref_low ?? null, ref_high: r.ref_high ?? null, ref_text: r.ref_text ?? null, flag: r.flag ?? null,
        taken_on: takenOn, ...this.#prov(who, { origin: args.origin, said_by: args.said_by }, 'health', 'lab')
      });
    }
    return { id, items: (args.results ?? []).length, file_saved: !!fileId };
  }

  t_server(who, args) {
    this.#canWrite(who, 'infra');
    const e = this.#find(args.name, 'server') ?? this.#newEntity(who, 'server', String(args.name).trim(), 'infra', args);
    let customerId;
    if (args.customer) {
      this.#canWrite(who, 'finance');
      customerId = (this.#find(args.customer, 'customer') ?? this.#newEntity(who, 'customer', args.customer, 'finance')).id;
    }
    let secretId;
    if (args.keychain_ref) {
      const cur = this.db.prepare("SELECT id FROM secret_refs WHERE entity_id = ? AND purpose = 'root 登录'").get(e.id);
      if (cur) { this.#update('secret_refs', 'id', cur.id, { vault_ref: args.keychain_ref, username: args.username ?? 'root' }); secretId = cur.id; }
      else {
        secretId = randomUUID();
        this.#insert('secret_refs', { id: secretId, entity_id: e.id, purpose: 'root 登录', username: args.username ?? 'root', vault: 'keychain', vault_ref: args.keychain_ref, ...this.#prov(who, args, 'infra', 'secret') });
      }
    }
    const fields = {
      ip: args.ip, provider: args.provider, region: args.region, cpu: args.cpu, memory_gb: args.memory_gb, disk_gb: args.disk_gb,
      bandwidth: args.bandwidth, os: args.os, purpose: args.purpose, expires_on: checkDate(args.expires_on, 'expires_on') ?? undefined,
      renew_price: args.renew_price, currency: args.currency, auto_renew: args.auto_renew == null ? undefined : (args.auto_renew ? 1 : 0),
      customer_id: customerId, secret_ref_id: secretId, status: args.status, note: args.note
    };
    if (this.db.prepare('SELECT 1 FROM servers WHERE entity_id = ?').get(e.id)) {
      this.#update('servers', 'entity_id', e.id, fields);
      return { id: e.id, updated: true };
    }
    this.#insert('servers', { entity_id: e.id, ...fields, currency: args.currency ?? null, ...this.#prov(who, args, 'infra', 'server') });
    return { id: e.id, created: true };
  }

  t_customer(who, args) {
    this.#canWrite(who, 'finance');
    const e = this.#find(args.name, 'customer') ?? this.#newEntity(who, 'customer', String(args.name).trim(), 'finance', args);
    const fields = { contact_name: args.contact_name, phone: args.phone, email: args.email, im: args.im, note: args.note };
    if (this.db.prepare('SELECT 1 FROM customers WHERE entity_id = ?').get(e.id)) {
      this.#update('customers', 'entity_id', e.id, fields);
      return { id: e.id, updated: true };
    }
    this.#insert('customers', { entity_id: e.id, ...fields, ...this.#prov(who, args, 'finance', 'customer') });
    return { id: e.id, created: true };
  }

  t_billing_set(who, args) {
    this.#canWrite(who, 'finance');
    const fields = {
      item: args.item, amount: args.amount, currency: args.currency, cycle: args.cycle,
      next_due_on: checkDate(args.next_due_on, 'next_due_on') ?? undefined, status: args.status, note: args.note,
      server_id: args.server ? this.#mustFind(args.server, 'server').id : undefined
    };
    let cur = args.id ? this.db.prepare('SELECT * FROM billing WHERE id = ?').get(args.id) : null;
    if (args.id && !cur) fail(`Unknown billing id: ${args.id}`);
    if (!cur) {
      if (!args.customer || !args.item) fail('customer and item are required to create a billing item');
      const c = this.#mustFind(args.customer, 'customer', '; register the customer with mem_customer first');
      cur = this.db.prepare('SELECT * FROM billing WHERE customer_id = ? AND item = ?').get(c.id, args.item);
      if (!cur) {
        if (args.amount == null || !args.cycle) fail('amount and cycle are required to create a billing item');
        const id = randomUUID();
        this.#insert('billing', { id, customer_id: c.id, ...fields, currency: args.currency ?? null, status: args.status ?? 'active', ...this.#prov(who, args, 'finance', 'billing') });
        return { id, created: true };
      }
    }
    this.#update('billing', 'id', cur.id, fields);
    return { id: cur.id, updated: true };
  }

  t_payment(who, args) {
    this.#canWrite(who, 'finance');
    let b = args.billing_id ? this.db.prepare('SELECT * FROM billing WHERE id = ?').get(args.billing_id) : null;
    if (!b && args.customer && args.item) {
      const c = this.#mustFind(args.customer, 'customer');
      b = this.db.prepare('SELECT * FROM billing WHERE customer_id = ? AND item = ?').get(c.id, args.item);
    }
    if (!b) fail('Billing item not found: pass billing_id, or customer + item');
    const paidOn = checkDate(args.paid_on, 'paid_on') ?? today();
    const id = randomUUID();
    this.#insert('payments', { id, billing_id: b.id, paid_on: paidOn, amount: args.amount ?? b.amount, currency: args.currency ?? b.currency, note: args.note ?? null, ...this.#prov(who, args, 'finance', 'payment') });
    const next = b.cycle === 'once' ? b.next_due_on : advance(b.next_due_on ?? paidOn, b.cycle);
    this.#update('billing', 'id', b.id, { last_paid_on: paidOn, next_due_on: next, status: b.cycle === 'once' ? 'ended' : undefined });
    return { id, billing_id: b.id, next_due_on: next };
  }

  t_retract(who, { table, id, reason }) {
    if (!['facts', 'relations'].includes(table)) fail('Only facts or relations can be retracted');
    const row = this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    if (!row) fail(`Record not found: ${id}`);
    this.#mayTouch(who, row.scope);
    this.#update(table, 'id', id, { status: 'retracted', note: [row.note, `作废:${reason}(${who.actor})`].filter(Boolean).join(';') });
    return { id, retracted: true };
  }

  // ── Reminders ────────────────────────────────────────────

  #rule(r) {
    return { freq: r.repeat_freq, interval: r.repeat_interval, startsAt: new Date(r.starts_at), tz: r.timezone };
  }

  #reminderView(r) {
    return clean({
      id: r.id, title: r.title, note: r.note, status: r.status,
      rule: describeRule(r.repeat_freq, r.repeat_interval),
      this_time: formatLocal(new Date(r.scheduled_at), r.timezone),
      remind_at: r.due_at !== r.scheduled_at ? formatLocal(new Date(r.due_at), r.timezone) + '(推迟过)' : undefined,
      pushed_this_time: r.status === 'active' ? `${r.push_count}/${REMINDER_MAX_PUSHES}` : undefined,
      next_push: r.status === 'active' && r.next_push_at ? formatLocal(new Date(r.next_push_at), r.timezone) : undefined,
      timezone: r.timezone
    });
  }

  #reminder(who, id) {
    const r = this.db.prepare('SELECT * FROM reminders WHERE id = ?').get(id);
    if (!r || r.assistant !== who.actor.split('@')[0]) fail(`Reminder not found: ${id}`);
    return r;
  }

  /** From the anchor and the rule, work out which occurrence is pending now */
  #plan(freq, interval, start, tz, now = new Date()) {
    if (!freq) return { index: 0, at: start };
    if (start > now) return { index: 0, at: start };
    return nextOccurrenceAfter({ freq, interval, startsAt: start, tz }, 0, now);
  }

  t_reminder_add(who, args) {
    const scope = args.scope ?? 'life';
    this.#canWrite(who, scope);
    const tz = args.timezone ?? DEFAULT_TIMEZONE;
    if (!isValidTimezone(tz)) fail(`Invalid time zone: ${tz}`);
    const start = parseLocal(args.at, tz);
    if (!start) fail('at must be formatted as "YYYY-MM-DD HH:mm"');
    const freq = args.repeat?.freq ?? null;
    const interval = Math.max(1, Math.round(args.repeat?.interval ?? 1));
    if (!freq && start <= new Date()) fail(`${formatLocal(start, tz)} is already in the past`);
    const { index, at } = this.#plan(freq, interval, start, tz);
    const assistant = who.actor.split('@')[0];
    const same = this.db.prepare("SELECT * FROM reminders WHERE assistant = ? AND title = ? AND scheduled_at = ? AND status = 'active'").get(assistant, args.title, at.toISOString());
    if (same) return { ...this.#reminderView(same), duplicate: true };
    const id = randomUUID();
    this.#insert('reminders', {
      id, assistant, recipient_id: this.#selfEntity(who).id, title: String(args.title).trim(), timezone: tz,
      starts_at: start.toISOString(), repeat_freq: freq, repeat_interval: interval, occurrence_index: index,
      scheduled_at: at.toISOString(), due_at: at.toISOString(), push_count: 0, next_push_at: at.toISOString(), status: 'active',
      note: args.note ?? null, ...this.#prov(who, args, scope, 'reminder')
    });
    return this.#reminderView(this.db.prepare('SELECT * FROM reminders WHERE id = ?').get(id));
  }

  t_reminder_list(who, { id, include_finished }) {
    const assistant = who.actor.split('@')[0];
    if (id) {
      const r = this.#reminder(who, id);
      const history = this.db.prepare('SELECT occurrence_at, status, completed_at, push_count, note FROM reminder_occurrences WHERE reminder_id = ? ORDER BY occurrence_at DESC LIMIT 30')
        .all(r.id).map((o) => clean({ ...o, occurrence_at: formatLocal(new Date(o.occurrence_at), r.timezone), completed_at: o.completed_at ? formatLocal(new Date(o.completed_at), r.timezone) : null }));
      const counts = this.db.prepare('SELECT status, count(*) n FROM reminder_occurrences WHERE reminder_id = ? GROUP BY status').all(r.id);
      return { reminder: this.#reminderView(r), totals: Object.fromEntries(counts.map((c) => [c.status, c.n])), history };
    }
    const rows = this.db.prepare(`SELECT * FROM reminders WHERE assistant = ? AND (status = 'active' OR ?) ORDER BY status != 'active', next_push_at`)
      .all(assistant, include_finished ? 1 : 0);
    return { count: rows.length, reminders: rows.map((r) => this.#reminderView(r)) };
  }

  #recordOccurrence(r, status, who, note = null) {
    this.db.prepare(`INSERT INTO reminder_occurrences (id, reminder_id, occurrence_at, status, completed_at, title, push_count, note, recorded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (reminder_id, occurrence_at) DO NOTHING`)
      .run(randomUUID(), r.id, r.scheduled_at, status, status === 'completed' ? nowIso() : null, r.title, r.push_count, note, who);
  }

  /** The current occurrence is over (completed or missed): recurring rules advance, one-offs end */
  #advance(r, finalStatus) {
    if (!r.repeat_freq) {
      this.#update('reminders', 'id', r.id, { status: finalStatus, next_push_at: null });
      return null;
    }
    const { index, at } = nextOccurrenceAfter(this.#rule(r), r.occurrence_index + 1, new Date());
    this.#update('reminders', 'id', r.id, {
      occurrence_index: index, scheduled_at: at.toISOString(), due_at: at.toISOString(), push_count: 0, next_push_at: at.toISOString(), last_pushed_at: null
    });
    return at;
  }

  t_reminder_done(who, { id, note }) {
    const r = this.#reminder(who, id);
    if (r.status !== 'active') fail(`This reminder is already ${r.status}`);
    this.#recordOccurrence(r, 'completed', who.actor, note);
    const next = this.#advance(r, 'done');
    return { id: r.id, done: formatLocal(new Date(r.scheduled_at), r.timezone), next: next ? formatLocal(next, r.timezone) : '(一次性提醒,已结束)' };
  }

  t_reminder_snooze(who, { id, minutes, until }) {
    const r = this.#reminder(who, id);
    if (r.status !== 'active') fail(`This reminder is already ${r.status}`);
    const t = until ? parseLocal(until, r.timezone) : new Date(Date.now() + Math.round(Number(minutes) || 0) * 60000);
    if (!t) fail('until must be formatted as "YYYY-MM-DD HH:mm"');
    if (t <= new Date()) fail('The snooze time must be in the future');
    this.#update('reminders', 'id', r.id, { due_at: t.toISOString(), push_count: 0, next_push_at: t.toISOString() });
    return { id: r.id, remind_at: formatLocal(t, r.timezone) };
  }

  t_reminder_update(who, args) {
    const r = this.#reminder(who, args.id);
    if (args.cancel) {
      this.#update('reminders', 'id', r.id, { status: 'cancelled', next_push_at: null });
      return { id: r.id, cancelled: true };
    }
    const patch = { title: args.title, note: args.note };
    if (args.at || args.timezone || args.repeat || args.one_time) {
      const tz = args.timezone ?? r.timezone;
      if (!isValidTimezone(tz)) fail(`Invalid time zone: ${tz}`);
      const start = args.at ? parseLocal(args.at, tz) : new Date(r.starts_at);
      if (!start) fail('at must be formatted as "YYYY-MM-DD HH:mm"');
      const freq = args.one_time ? null : args.repeat?.freq ?? r.repeat_freq;
      const interval = Math.max(1, Math.round(args.repeat?.interval ?? r.repeat_interval));
      if (!freq && start <= new Date()) fail(`${formatLocal(start, tz)} is already in the past`);
      const { index, at } = this.#plan(freq, interval, start, tz);
      Object.assign(patch, {
        timezone: tz, starts_at: start.toISOString(), repeat_freq: freq, repeat_interval: interval, occurrence_index: index,
        scheduled_at: at.toISOString(), due_at: at.toISOString(), push_count: 0, next_push_at: at.toISOString(), status: 'active'
      });
    }
    this.#update('reminders', 'id', r.id, patch);
    return this.#reminderView(this.db.prepare('SELECT * FROM reminders WHERE id = ?').get(r.id));
  }

  /**
   * Periodic check (the main process calls it every 30 seconds): advances due reminders by one step and returns
   * the events for which an assistant must be woken. After downtime, missed pushes are not replayed: the push
   * count is recomputed from the elapsed time and skipped ahead.
   */
  reminderTick(now = new Date()) {
    return this.#tx(() => {
      const events = [];
      const rows = this.db.prepare("SELECT * FROM reminders WHERE status = 'active' AND next_push_at IS NOT NULL AND next_push_at <= ?").all(now.toISOString());
      for (const r of rows) {
        const due = new Date(r.due_at);
        const slots = now < due ? 0 : Math.floor((now - due) / REMINDER_INTERVAL_MS) + 1;
        if (slots === 0) { this.#update('reminders', 'id', r.id, { next_push_at: r.due_at }); continue; }
        if (r.push_count >= REMINDER_MAX_PUSHES || slots > REMINDER_MAX_PUSHES) {
          this.#recordOccurrence(r, 'missed', 'system');
          this.#advance(r, 'missed');
          continue;
        }
        const count = Math.max(r.push_count + 1, slots);
        this.#update('reminders', 'id', r.id, {
          push_count: count, last_pushed_at: now.toISOString(), next_push_at: new Date(due.getTime() + count * REMINDER_INTERVAL_MS).toISOString()
        });
        events.push({
          assistant: r.assistant,
          reminder: {
            id: r.id, title: r.title, note: r.note, attempt: count, max: REMINDER_MAX_PUSHES,
            scheduled_at: r.scheduled_at, time: formatLocal(new Date(r.scheduled_at), r.timezone),
            rule: describeRule(r.repeat_freq, r.repeat_interval), snoozed: r.due_at !== r.scheduled_at
          }
        });
      }
      return events;
    });
  }

  /** Checked by the waker before waking the assistant: is this reminder still waiting for this push (not completed, cancelled or snoozed meanwhile)? */
  reminderStillDue(id, scheduledAt, attempt) {
    const r = this.db.prepare('SELECT status, scheduled_at, push_count FROM reminders WHERE id = ?').get(id);
    return !!r && r.status === 'active' && r.scheduled_at === scheduledAt && r.push_count === attempt;
  }
}
