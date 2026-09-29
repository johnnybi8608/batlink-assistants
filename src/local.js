// Local settings shared by the command-line scripts: the daemon's HTTP port and the data directory,
// both taken from config.json. The only override is AGENTS_CONFIG (path of the config file, relative to the current
// directory); every process — daemon, waker, scripts — resolves it the same way.

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_PATH = resolve(process.env.AGENTS_CONFIG ?? join(ROOT, 'config.json'));

let config = {};
try { config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch {}

export const PORT = String(config.httpPort ?? 8790);
export const DATA_DIR = resolve(ROOT, config.dataDir ?? './data');
export const API = `http://127.0.0.1:${PORT}`;

/** --agent is required: there is no default bot. */
export function requireAgent(value, usage) {
  if (value) return value;
  console.error(`missing --agent <bot id>. ${usage ?? ''}`.trim());
  process.exit(2);
}

// ── Local API authentication ─────────────────────────────────────────────
// The daemon's HTTP API only accepts requests that carry the token from <dataDir>/api-token (created by the daemon
// on first start, mode 600). Web pages in your browser cannot read that file, so they cannot drive your bots.
export const API_TOKEN_FILE = join(DATA_DIR, 'api-token');

/** Reads the API token (the daemon creates it); null when the daemon has never run. */
export function readApiToken(file = API_TOKEN_FILE) {
  try { return readFileSync(file, 'utf8').trim() || null; } catch { return null; }
}

/**
 * fetch() against the local daemon API with the token and a JSON content type.
 * @param {string} path  e.g. "/dm" or "/status"
 * @param {RequestInit} init
 * @param {{ port?: string|number, tokenFile?: string }} [where]  overrides (used by the memdb MCP bridge)
 */
export function localFetch(path, init = {}, where = {}) {
  const token = readApiToken(where.tokenFile ?? API_TOKEN_FILE);
  return fetch(`http://127.0.0.1:${where.port ?? PORT}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  });
}

// ── Media paths ──────────────────────────────────────────────────────────
// Messages carry media as text markers ("[图片] <path> (w×h)", "[语音 N 秒] <path>"), written by src/agent.js when
// a real image / voice message arrives. Message text is not proof: anyone could type such a marker. So a path taken
// from a marker is only used when it really is a file inside <dataDir>/media/ — never any other file on disk.
export const MEDIA_DIR = join(DATA_DIR, 'media');

export function isMediaFile(path, agent) {
  try {
    // media of this bot only (data/media/<bot>/…): one assistant cannot open another bot's or another chat's files by path
    if (!agent || /[\/]|^\.\.?$/.test(String(agent))) return false;
    const root = realpathSync(join(MEDIA_DIR, String(agent))) + sep;
    const real = realpathSync(path);
    return real.startsWith(root) && statSync(real).isFile();
  } catch {
    return false;
  }
}
