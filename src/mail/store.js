// Mail assistant: configuration helpers and local state.
//
// ---------------------------------------------------------------------------------------------
// config.json → "mail" (all fields optional except accounts, which bin/mail-auth.js fills in):
//
//   "mail": {
//     "agent": "wangcai",              // id of the bot account (in config.agents) that pushes mail and
//                                      // talks to the owner about it. That agent needs "mailCommands": true
//                                      // so the owner's "发送" / "原文" replies become commands. Default "wangcai".
//     "accounts": [                    // mailboxes to watch; bin/mail-auth.js adds / updates entries
//       {
//         "id": "gmail",               // short ASCII id: used in #refs, file names and the secret name "mail-<id>"
//         "provider": "gmail",         // only "gmail" (Gmail / Google Workspace via the Gmail API) is supported
//         "label": "工作邮箱",          // name shown in pushes ("📧 工作邮箱 #12"); defaults to the id
//         "address": "you@example.com" // mailbox address, shown on promo/spam summary cards; filled in by mail-auth
//       }
//     ],
//     "pollSeconds": 30,               // how often each mailbox is checked for new mail. Default 30.
//     "translate": {                   // one-shot model used to translate non-Chinese mail and to classify promo/spam.
//       "engine": "claude",            // "claude" (Claude Code CLI, zero tools — recommended; mail is untrusted input) or
//                                      // "codex" (Codex CLI, read-only sandbox: it can still read files).
//       "model": ""                    // optional model id; empty = the CLI default (for claude: CLAUDE_MODEL env,
//     }                                // see src/proc.js). Default { "engine": "claude" }.
//   }
//
// Secrets: the OAuth refresh token of mailbox <id> is the secret "mail-<id>" (src/secrets.js).
// The Google OAuth client file (downloaded by the user from Google Cloud) lives at
// <dataDir>/mail/client.json (shared by all mailboxes) or <dataDir>/mail/<id>/client.json (per mailbox).
// ---------------------------------------------------------------------------------------------
//
// Local state under <dataDir>/mail/:
//   index.json          shared by all mailboxes: message numbers #N and draft numbers DN are allocated from
//                       one sequence, so there are never two different #12s
//   <accountId>/state.json  per mailbox: Gmail historyId, ids of messages already pushed
// index.json is written by two processes (mail watcher and the assistant); writes are serialised with a
// directory lock and are atomic (write temp file + rename).

import { readFileSync, writeFileSync, renameSync, mkdirSync, rmdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const AGENTS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const CONFIG_PATH = resolve(process.env.AGENTS_CONFIG ?? join(AGENTS_ROOT, 'config.json'));
export const DEFAULT_MAIL_AGENT = 'wangcai';

export const loadConfig = () => JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));

/** Normalised view of config.mail (see the field list above). */
export function mailSettings(config) {
  const raw = config?.mail ?? {};
  const mail = Array.isArray(raw) ? { accounts: raw } : raw;
  return {
    agent: mail.agent || DEFAULT_MAIL_AGENT,
    accounts: (mail.accounts ?? []).map((a) => ({ ...a, provider: a.provider ?? 'gmail', label: a.label || a.id })),
    pollSeconds: Number(mail.pollSeconds) > 0 ? Number(mail.pollSeconds) : 30,
    translate: { engine: mail.translate?.engine || 'claude', model: mail.translate?.model || '' }
  };
}

export const mailAccounts = (config) => mailSettings(config).accounts;
export const accountOf = (config, accountId) => mailAccounts(config).find((a) => a.id === accountId) ?? null;
export const labelOf = (config, accountId) => accountOf(config, accountId)?.label ?? accountId;

/** <dataDir> resolved against the repository root (config.dataDir, default ./data). */
export const dataDirOf = (config) => resolve(AGENTS_ROOT, config?.dataDir ?? './data');

let cachedMailRoot = null;
/** <dataDir>/mail */
export function mailRoot() {
  if (!cachedMailRoot) {
    let config = {};
    try { config = loadConfig(); } catch {}
    cachedMailRoot = join(dataDirOf(config), 'mail');
  }
  return cachedMailRoot;
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

export function accountDir(accountId) {
  const dir = join(mailRoot(), accountId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const loadState = (id) => readJson(join(accountDir(id), 'state.json'), { historyId: null, pushed: [] });
export const saveState = (id, state) => writeJson(join(accountDir(id), 'state.json'), state);

const indexPath = () => join(mailRoot(), 'index.json');
const lockPath = () => join(mailRoot(), 'index.lock');

const emptyIndex = () => ({ nextMsgNo: 1, nextDraftNo: 1, messages: {}, drafts: {} });
export const loadIndex = () => readJson(indexPath(), emptyIndex());

/** Read-modify-write index.json under the lock; returns whatever fn returns. */
export async function withIndex(fn) {
  mkdirSync(mailRoot(), { recursive: true });
  const lock = lockPath();
  for (let i = 0; ; i += 1) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      // A lock older than 30 seconds belongs to a crashed process: treat it as stale
      try { if (Date.now() - statSync(lock).mtimeMs > 30_000) rmdirSync(lock); } catch {}
      if (i > 200) throw new Error('Timed out waiting for the mail index lock');
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  try {
    const index = loadIndex();
    const result = await fn(index);
    writeJson(indexPath(), index);
    return result;
  } finally {
    try { rmdirSync(lock); } catch {}
  }
}

/** Allocate a #number for a pushed (or searched) message, shared across mailboxes; keeps the latest 1000. */
export function assignMessageNo(info) {
  return withIndex((index) => {
    const no = index.nextMsgNo;
    index.nextMsgNo += 1;
    index.messages[no] = info;
    const keys = Object.keys(index.messages).map(Number).sort((a, b) => a - b);
    for (const k of keys.slice(0, Math.max(0, keys.length - 1000))) delete index.messages[k];
    return no;
  });
}

/** "#12" → { no, account, id, threadId, … }; null when unknown. */
export function lookupMessage(ref) {
  const m = /#?\s*(\d+)/.exec(String(ref ?? ''));
  if (!m) return null;
  const info = loadIndex().messages[m[1]];
  return info ? { no: Number(m[1]), ...info } : null;
}

export const exists = existsSync;
