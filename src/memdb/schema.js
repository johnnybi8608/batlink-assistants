// Schema of the personal memory database (shared by every assistant and AI session).
//
// Design principles:
//   - History is never lost: whenever a row is updated or deleted, triggers copy the old row into `history`;
//     `events`, `history` and `access_log` are append-only. The only exception is an explicit hard delete
//     requested by the owner: db.js purge() removes the row together with its history and search index entries.
//   - Latest wins, measured by when the thing happened (valid_from / *_on), not by when it was recorded;
//     an AI guess (origin=inferred) never overrides something the owner stated. This is enforced by the write API.
//   - Writes are permissioned per role (write_permissions); reads are open (except a few roles restricted in service.js).
//   - Passwords and private keys never go in here: secret_refs only records the name of the keychain entry.
//   - Portable to PostgreSQL later: text ids, ISO-8601 text timestamps, JSON stored as text.

const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

// Provenance columns carried by every business table
const PROVENANCE = `
  scope         TEXT NOT NULL REFERENCES scopes(name),
  recorded_by   TEXT NOT NULL,                 -- who wrote it: owner / family / desktop / claude@<project> / lingxi@dm / import ...
  origin        TEXT NOT NULL DEFAULT 'stated' CHECK (origin IN ('stated','evidence','inferred')),
                                               -- stated = said by the owner (or family) / evidence = backed by execution output / inferred = AI guess
  source_system TEXT,                          -- batlink-group / batlink-dm / desktop / worklog / memory-file / manual
  source_ref    TEXT,                          -- message id, session id, file path ...
  idem_key      TEXT UNIQUE,                   -- idempotency key: repeated writes from the same source count once
  note          TEXT,
  stated_by     TEXT,                          -- who said it: owner / family; empty when the AI found or inferred it
  created_at    TEXT NOT NULL DEFAULT ${NOW},
  updated_at    TEXT NOT NULL DEFAULT ${NOW}`;

// Each entry is one schema version. A fresh install runs them all in order.
// The owner entity (id 'owner') is inserted by db.js after the first migration, using the configured name.
export const MIGRATIONS = [
  // v1
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);

  -- Content categories (labels are shown to the AI, hence Chinese)
  CREATE TABLE scopes (name TEXT PRIMARY KEY, label TEXT NOT NULL);
  INSERT INTO scopes VALUES
    ('work','工作'), ('life','生活'), ('personal','个人'), ('family','家庭'),
    ('health','健康'), ('infra','服务器与服务'), ('finance','客户与收费');

  -- Which role may write which scope (reads are not restricted here)
  CREATE TABLE write_permissions (
    role  TEXT NOT NULL,                         -- owner / family / desktop / assistant / project / chat / import / family-assistant
    scope TEXT NOT NULL REFERENCES scopes(name),
    PRIMARY KEY (role, scope)
  );
  INSERT INTO write_permissions (role, scope)
    SELECT r.role, s.name FROM (SELECT 'owner' AS role UNION ALL SELECT 'family' UNION ALL SELECT 'desktop' UNION ALL SELECT 'assistant' UNION ALL SELECT 'import') r, scopes s;
  INSERT INTO write_permissions VALUES ('project','work');
  INSERT INTO write_permissions VALUES ('chat','personal'), ('chat','family'), ('chat','life'), ('chat','health');
  -- Assistant serving a family member: same write scopes as a chat assistant;
  -- read restrictions (no work / infra / finance) live in service.js
  INSERT INTO write_permissions VALUES ('family-assistant','personal'), ('family-assistant','family'), ('family-assistant','life'), ('family-assistant','health');

  -- ── Generic tables ───────────────────────────────────────

  -- People, projects, servers, customers, organisations, accounts ...
  CREATE TABLE entities (
    id      TEXT PRIMARY KEY,
    type    TEXT NOT NULL CHECK (type IN ('person','project','server','customer','org','account','place','other')),
    name    TEXT NOT NULL,
    aliases TEXT NOT NULL DEFAULT '[]',          -- JSON array: nicknames, other names
    summary TEXT,
    status  TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
    ${PROVENANCE}
  );
  CREATE INDEX entities_type ON entities(type, name);

  -- Relations: spouse, child, a project uses a server, a server is rented to a customer ...
  CREATE TABLE relations (
    id            TEXT PRIMARY KEY,
    from_id       TEXT NOT NULL REFERENCES entities(id),
    type          TEXT NOT NULL,                 -- spouse / child / parent / uses / owned_by / member_of ...
    to_id         TEXT NOT NULL REFERENCES entities(id),
    valid_from    TEXT,
    valid_to      TEXT,
    status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','conflict','unverified','retracted')),
    supersedes_id TEXT REFERENCES relations(id),
    ${PROVENANCE}
  );
  CREATE INDEX relations_from ON relations(from_id, type);
  CREATE INDEX relations_to ON relations(to_id, type);

  -- Facts / preferences / conclusions: when a new one replaces an old one, the old one becomes
  -- 'superseded' and the new one points at it through supersedes_id
  CREATE TABLE facts (
    id            TEXT PRIMARY KEY,
    entity_id     TEXT REFERENCES entities(id),
    category      TEXT NOT NULL,                 -- preference / habit / decision / status / profile / date ...
    property      TEXT NOT NULL,                 -- e.g. reply style, birthday
    value         TEXT NOT NULL,
    valid_from    TEXT,                          -- when it became true (not when it was recorded)
    valid_to      TEXT,
    verified_at   TEXT,
    status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','conflict','unverified','retracted')),
    supersedes_id TEXT REFERENCES facts(id),
    ${PROVENANCE}
  );
  CREATE INDEX facts_entity ON facts(entity_id, category, property, status);
  CREATE INDEX facts_scope ON facts(scope, status);

  -- Work log / decisions / tasks / deployments: append-only
  CREATE TABLE events (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL CHECK (kind IN ('change','deploy','decision','task','issue','note','worklog')),
    project_id  TEXT REFERENCES entities(id),
    entity_id   TEXT REFERENCES entities(id),
    title       TEXT NOT NULL,
    body        TEXT,
    stage       TEXT CHECK (stage IN ('changed','built','deployed','installed','accepted','open','done','dropped')),
                                                 -- changed / built / deployed / installed / accepted by the owner are recorded separately
    occurred_at TEXT NOT NULL,
    ${PROVENANCE}
  );
  CREATE INDEX events_project ON events(project_id, occurred_at);
  CREATE INDEX events_time ON events(occurred_at);

  -- Files (e.g. original health reports): stored elsewhere, only location and hash are kept here
  CREATE TABLE files (
    id        TEXT PRIMARY KEY,
    entity_id TEXT REFERENCES entities(id),
    kind      TEXT NOT NULL,                     -- health-report / contract / image / other
    location  TEXT NOT NULL,                     -- local path or remote object URI
    sha256    TEXT NOT NULL,
    mime      TEXT,
    bytes     INTEGER,
    encrypted INTEGER NOT NULL DEFAULT 1,
    ${PROVENANCE}
  );

  -- Credential references: never the secret itself
  CREATE TABLE secret_refs (
    id         TEXT PRIMARY KEY,
    entity_id  TEXT REFERENCES entities(id),
    purpose    TEXT NOT NULL,                    -- root login / panel / API ...
    username   TEXT,
    vault      TEXT NOT NULL DEFAULT 'keychain',
    vault_ref  TEXT NOT NULL,                    -- service name of the keychain entry
    rotated_on TEXT,
    expires_on TEXT,
    ${PROVENANCE}
  );

  -- ── Health ───────────────────────────────────────────────

  CREATE TABLE medications (
    id         TEXT PRIMARY KEY,
    person_id  TEXT NOT NULL REFERENCES entities(id),
    name       TEXT NOT NULL,
    dose       TEXT,                             -- e.g. 10mg
    frequency  TEXT,                             -- e.g. once a day, at bedtime
    purpose    TEXT,
    prescriber TEXT,
    started_on TEXT,
    stopped_on TEXT,
    status     TEXT NOT NULL DEFAULT 'taking' CHECK (status IN ('taking','paused','stopped')),
    ${PROVENANCE}
  );
  CREATE INDEX medications_person ON medications(person_id, status);

  CREATE TABLE health_reports (
    id          TEXT PRIMARY KEY,
    person_id   TEXT NOT NULL REFERENCES entities(id),
    title       TEXT NOT NULL,
    kind        TEXT,                            -- checkup / lab test / imaging / outpatient visit
    taken_on    TEXT NOT NULL,
    institution TEXT,
    file_id     TEXT REFERENCES files(id),
    summary     TEXT,
    ${PROVENANCE}
  );
  CREATE INDEX health_reports_person ON health_reports(person_id, taken_on);

  -- Lab results: one row per item, so trends are easy to query
  CREATE TABLE lab_results (
    id         TEXT PRIMARY KEY,
    report_id  TEXT REFERENCES health_reports(id),
    person_id  TEXT NOT NULL REFERENCES entities(id),
    item       TEXT NOT NULL,                    -- name of the measured item
    value_num  REAL,
    value_text TEXT,
    unit       TEXT,
    ref_low    REAL,
    ref_high   REAL,
    ref_text   TEXT,
    flag       TEXT CHECK (flag IN ('H','L','N','A')),
    taken_on   TEXT NOT NULL,
    ${PROVENANCE}
  );
  CREATE INDEX lab_results_item ON lab_results(person_id, item, taken_on);

  -- ── Servers, customers, billing ──────────────────────────

  CREATE TABLE servers (
    entity_id     TEXT PRIMARY KEY REFERENCES entities(id),
    ip            TEXT,
    provider      TEXT,
    region        TEXT,
    cpu           TEXT,
    memory_gb     REAL,
    disk_gb       REAL,
    bandwidth     TEXT,
    os            TEXT,
    purpose       TEXT,
    expires_on    TEXT,
    renew_price   REAL,
    currency      TEXT,
    auto_renew    INTEGER,
    customer_id   TEXT REFERENCES entities(id),  -- customer it is rented to; empty for own use
    secret_ref_id TEXT REFERENCES secret_refs(id),
    status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','cancelled')),
    ${PROVENANCE}
  );
  CREATE INDEX servers_expires ON servers(status, expires_on);

  CREATE TABLE customers (
    entity_id    TEXT PRIMARY KEY REFERENCES entities(id),
    contact_name TEXT,
    phone        TEXT,
    email        TEXT,
    im           TEXT,                           -- WeChat / Telegram / Batlink
    ${PROVENANCE}
  );

  CREATE TABLE billing (
    id           TEXT PRIMARY KEY,
    customer_id  TEXT NOT NULL REFERENCES entities(id),
    server_id    TEXT REFERENCES entities(id),
    item         TEXT NOT NULL,
    amount       REAL NOT NULL,
    currency     TEXT,
    cycle        TEXT NOT NULL CHECK (cycle IN ('monthly','quarterly','half-yearly','yearly','once')),
    next_due_on  TEXT,
    last_paid_on TEXT,
    status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','ended')),
    ${PROVENANCE}
  );
  CREATE INDEX billing_due ON billing(status, next_due_on);

  CREATE TABLE payments (
    id         TEXT PRIMARY KEY,
    billing_id TEXT NOT NULL REFERENCES billing(id),
    paid_on    TEXT NOT NULL,
    amount     REAL NOT NULL,
    currency   TEXT,
    ${PROVENANCE}
  );

  -- ── Reminders ────────────────────────────────────────────
  -- A rule only holds its "current occurrence"; when that occurrence is completed or missed the rule
  -- advances to the next one. The outcome of every occurrence is stored separately.

  CREATE TABLE reminders (
    id               TEXT PRIMARY KEY,
    assistant        TEXT NOT NULL,              -- agent id that sends it (whoever created it sends it)
    recipient_id     TEXT NOT NULL REFERENCES entities(id),  -- who gets reminded (the person the assistant serves)
    title            TEXT NOT NULL,
    timezone         TEXT NOT NULL,              -- IANA zone name; recurrences are computed in its local time
    starts_at        TEXT NOT NULL,              -- anchor (UTC ISO); every occurrence is a whole number of periods from it
    repeat_freq      TEXT CHECK (repeat_freq IN ('day','week','month')),  -- empty = one-off
    repeat_interval  INTEGER NOT NULL DEFAULT 1,
    occurrence_index INTEGER NOT NULL DEFAULT 0, -- index of the current occurrence (0-based)
    scheduled_at     TEXT NOT NULL,              -- when the current occurrence is due according to the rule
    due_at           TEXT NOT NULL,              -- when it actually fires (later than scheduled_at after a snooze)
    push_count       INTEGER NOT NULL DEFAULT 0, -- how many times the current occurrence has been pushed
    next_push_at     TEXT,                       -- next time the assistant gets woken for it
    last_pushed_at   TEXT,
    status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','done','missed','cancelled')),
    ${PROVENANCE}
  );
  CREATE INDEX reminders_pending ON reminders(status, next_push_at);

  CREATE TABLE reminder_occurrences (
    id            TEXT PRIMARY KEY,
    reminder_id   TEXT NOT NULL REFERENCES reminders(id),
    occurrence_at TEXT NOT NULL,                 -- which occurrence (= scheduled_at at that time)
    status        TEXT NOT NULL CHECK (status IN ('completed','missed')),
    completed_at  TEXT,
    title         TEXT NOT NULL,                 -- snapshot, so history survives renames and deleted rules
    push_count    INTEGER NOT NULL DEFAULT 0,
    note          TEXT,
    recorded_by   TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT ${NOW},
    UNIQUE (reminder_id, occurrence_at)
  );
  CREATE INDEX reminder_occurrences_time ON reminder_occurrences(reminder_id, occurrence_at);

  -- ── History, audit, search ───────────────────────────────

  -- The previous version of any business row before it was updated / deleted (written by triggers)
  CREATE TABLE history (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    tbl        TEXT NOT NULL,
    row_id     TEXT NOT NULL,
    op         TEXT NOT NULL CHECK (op IN ('update','delete')),
    old_json   TEXT NOT NULL,
    changed_at TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE INDEX history_row ON history(tbl, row_id, seq);

  -- Who read or wrote what and when (never the secret content itself)
  CREATE TABLE access_log (
    seq    INTEGER PRIMARY KEY AUTOINCREMENT,
    at     TEXT NOT NULL DEFAULT ${NOW},
    actor  TEXT NOT NULL,
    action TEXT NOT NULL,                        -- read / search / write / purge
    tbl    TEXT,
    row_id TEXT,
    ok     INTEGER NOT NULL DEFAULT 1,
    detail TEXT
  );

  -- Full-text search: trigram tokenizer, so CJK terms of 3+ characters hit the index; shorter terms use LIKE in the API
  CREATE VIRTUAL TABLE search USING fts5(tbl UNINDEXED, row_id UNINDEXED, body, tokenize = 'trigram');
  `,
  // v2: access_log.detail used to keep the first 200 characters of every call's arguments — content that survived a
  // hard delete. It now holds only argument names and record ids; blank out what older versions wrote.
  // (access_log is append-only; its update guard is dropped here and re-created when the database is opened.)
  `
  DROP TRIGGER IF EXISTS mem_access_log_no_upd;
  UPDATE access_log SET detail = NULL WHERE detail IS NOT NULL;
  `
];

/** Generic names that also resolve to the owner entity (lookups only; kept in aliases) */
export const OWNER_ALIASES = ['主人', '机主', '我'];

/** Business tables with history triggers (old row saved before update / delete) */
export const TRACKED_TABLES = [
  'entities', 'relations', 'facts', 'files', 'secret_refs',
  'medications', 'health_reports', 'lab_results',
  'servers', 'customers', 'billing', 'payments',
  'reminders', 'reminder_occurrences'
];

/** Append-only tables: no updates allowed */
export const APPEND_ONLY_TABLES = ['events', 'history', 'access_log'];

/** Tables indexed for full-text search: primary key column + the text expression to index */
export const SEARCH_SOURCES = {
  entities: { pk: 'id', body: "name || ' ' || aliases || ' ' || coalesce(summary,'') || ' ' || coalesce(note,'')" },
  facts: { pk: 'id', body: "category || ' ' || property || ' ' || value || ' ' || coalesce(note,'')" },
  events: { pk: 'id', body: "title || ' ' || coalesce(body,'')" },
  medications: { pk: 'id', body: "name || ' ' || coalesce(dose,'') || ' ' || coalesce(purpose,'') || ' ' || coalesce(note,'')" },
  health_reports: { pk: 'id', body: "title || ' ' || coalesce(kind,'') || ' ' || coalesce(institution,'') || ' ' || coalesce(summary,'')" },
  lab_results: { pk: 'id', body: "item || ' ' || coalesce(value_text,'') || ' ' || coalesce(note,'')" },
  servers: { pk: 'entity_id', body: "coalesce(ip,'') || ' ' || coalesce(provider,'') || ' ' || coalesce(region,'') || ' ' || coalesce(purpose,'') || ' ' || coalesce(note,'')" },
  customers: { pk: 'entity_id', body: "coalesce(contact_name,'') || ' ' || coalesce(im,'') || ' ' || coalesce(note,'')" },
  billing: { pk: 'id', body: "item || ' ' || coalesce(note,'')" },
  reminders: { pk: 'id', body: "title || ' ' || coalesce(note,'')" }
};
