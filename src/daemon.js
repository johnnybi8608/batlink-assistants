// Main process: runs N AI bot identities on Batlink.
//
// It does not "think" by itself. The split is:
//   this process -- ears and mouth: receives messages and appends them to per-group message streams,
//                   and exposes a local HTTP API for sending
//   AI sessions  -- the brain: woken up for their stream (bin/waker.js, or bin/listen.js), they compose
//                   a reply with their own context and send it back via bin/send.js / bin/dm.js
//
// On first start, every entry in config.agents gets a deterministic identity derived from the master
// seed, comes online, and sends the owner a one-time hello (so it shows up in the owner's contacts).
//
// Local API (listens on 127.0.0.1 only, unless AGENTS_HTTP_HOST is set):
//   GET  /status                                 status of all bots (polled by status tools)
//   GET  /groups?agent=<id>
//   GET  /members?agent=<id>&group=<groupId>
//   GET  /history?agent=<id>&group=<groupId>&limit=30
//   POST /send   {agent, groupId, text, mentionOwner?}
//   POST /hello  {agent}                         send the owner a "hello" again (to appear in contacts)
//   POST /profile {agent, groupId, displayName}  change the bot's nickname in one group
//   POST /send-image {agent, groupId, path}      send a local image to a group (compressed automatically)
//   POST /leave {agent, groupId}                 mark a group as left
//   POST /dm {agent, text, origin?}              direct message to the bot's owner (origin marks messages
//                                                that did not come from the AI session, e.g. mail notifications)
//   POST /dm-image {agent, path, origin?}        direct image to the owner
//   POST /dm-voice {agent, text, voiceId?, speed?, languageBoost?, origin?}  direct voice message to the owner
//   GET  /mem/family?self=<entityId>             memdb: family members
//   GET  /mem/reminder-due?id=&scheduled=&attempt=  memdb: is this reminder still due
//   POST /mem/call {identity, tool, args}        memdb tool call (used by bin/mem-mcp.js)

import { createServer } from 'node:http';
import { isSafeGroupId, pathInside } from './safe-id.js';
import { readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync, lstatSync, chmodSync, rmSync } from 'node:fs';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeClient } from './batlink/node-client.js';
import { deriveIdentity, normalizePublicKey } from './batlink/keys.js';
import { erc20AddressFromPublicKey } from './batlink/crypto.js';
import { decodeBase64Url } from './batlink/base64url.js';
import { Agent } from './agent.js';
import { AgentStore } from './store.js';
import { createLogger } from './logger.js';
import { readHistory } from './history.js';
import { openMemDb } from './memdb/db.js';
import { synthesizeMiniMax, toVoiceMessage, VOICE_MAX_MS } from './voice.js';
import { MemService, MemError } from './memdb/service.js';

// Config: <repo>/config.json (see config.example.json); AGENTS_CONFIG overrides the path.
// Relative paths inside it (dataDir) are resolved against the repo root.
const root = fileURLToPath(new URL('..', import.meta.url));
const configPath = resolve(process.env.AGENTS_CONFIG ?? join(root, 'config.json'));
if (!existsSync(configPath)) {
  console.error(`Config not found: ${configPath}\nCopy config.example.json to config.json and fill in owner.address.`);
  process.exit(1);
}
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const dataDir = resolve(root, config.dataDir ?? './data');
const logger = createLogger(config.logLevel ?? 'info');
mkdirSync(dataDir, { recursive: true });

// The data directory and the key files in it must be private to you: checked on every start (a file restored from
// a backup or copied from another Mac may have come back with looser permissions)
function restrictMode(path, mode) {
  try {
    const st = lstatSync(path);
    if ((st.mode & 0o777) !== mode) { chmodSync(path, mode); logger.warn({ path, was: (st.mode & 0o777).toString(8) }, 'permissions were too open; restricted to the owner'); }
  } catch {}
}
restrictMode(dataDir, 0o700);

const owner = config.owner ?? {};
if (!config.nodeBaseUrl) {
  logger.error({ configPath }, 'config.nodeBaseUrl is missing');
  process.exit(1);
}
if (!owner.publicKey && !/^0x[0-9a-fA-F]{40}$/.test(String(owner.address ?? ''))) {
  logger.error({ configPath }, 'config.owner.address is missing or not a 0x Batlink address');
  process.exit(1);
}
if (!Array.isArray(config.agents) || !config.agents.length) {
  logger.error({ configPath }, 'config.agents is empty; nothing to run');
  process.exit(1);
}

// Master seed: every bot identity is derived from it. Generated randomly on first start.
// Losing it means every bot gets a new address.
/** A bot's device id: random on first start, kept in its own data folder and never changed. */
function loadOrCreateDeviceId(dir) {
  const file = join(dir, 'device-id');
  try {
    const id = readFileSync(file, 'utf8').trim();
    if (/^[A-Za-z0-9-]{8,64}$/.test(id)) return id;
  } catch {}
  mkdirSync(dir, { recursive: true });
  const id = randomUUID();
  writeFileSync(file, id + '\n', { mode: 0o600 });
  return id;
}

function loadOrCreateSeed() {
  const path = join(dataDir, 'master-seed.key');
  if (existsSync(path)) {
    // The seed IS the bots' identity: only tighten its permissions, never regenerate it; refuse a symlink
    if (lstatSync(path).isSymbolicLink()) throw new Error(`${path} is a symlink; refusing to use it`);
    restrictMode(path, 0o600);
    return readFileSync(path, 'utf8').trim();
  }
  const seed = randomBytes(32).toString('hex');
  writeFileSync(path, seed + '\n', { mode: 0o600 });
  logger.warn({ path }, 'generated a new master seed; back it up, losing it changes every bot address');
  return seed;
}

/**
 * Batlink address (0x...) -> public key. Resolved through the node like the app does, then verified
 * that the key really derives this address (never trust the directory blindly). The result is cached;
 * cacheName keeps different people apart.
 */
async function resolvePubkeyForAddress(client, anyAgent, rawAddress, cacheName) {
  const address = String(rawAddress ?? '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error(`address missing or malformed: ${rawAddress}`);
  const cachePath = join(dataDir, cacheName);
  if (existsSync(cachePath)) {
    const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
    if (cached.address === address && cached.pubkey) return cached.pubkey;
  }
  const token = await anyAgent.ensureToken();
  const res = await client.resolveAddress(address, token);
  const pubkey = normalizePublicKey(res?.publicKey ?? res?.userPubkey ?? '');
  if (!pubkey) throw new Error(`could not resolve address: ${address}`);
  const derived = erc20AddressFromPublicKey(decodeBase64Url(pubkey)).toLowerCase();
  if (derived !== address) throw new Error(`public key does not match address: ${derived} != ${address}`);
  writeFileSync(cachePath, JSON.stringify({ address, pubkey }, null, 2));
  return pubkey;
}

async function resolveOwnerPubkey(client, anyAgent) {
  if (owner.publicKey) return normalizePublicKey(owner.publicKey);
  return resolvePubkeyForAddress(client, anyAgent, owner.address, 'owner.json');
}

/**
 * Each bot's owner: the main owner by default. A bot with its own `ownerAddress` in config (e.g. a
 * personal assistant set up for a family member) only serves that person.
 * While ownerAddress is still a placeholder (not a 0x address) this returns null: the bot comes online
 * but accepts no direct messages from anyone and sends no hello.
 */
async function resolveAgentOwner(spec, agent, defaultOwner) {
  if (!('ownerAddress' in spec)) return defaultOwner;
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(spec.ownerAddress ?? ''))) {
    logger.warn({ agent: spec.id }, 'ownerAddress is still a placeholder; not accepting direct messages yet');
    return null;
  }
  try {
    return await resolvePubkeyForAddress(client, agent, spec.ownerAddress, `owner-${spec.id}.json`);
  } catch (error) {
    logger.error({ agent: spec.id, err: String(error) }, 'failed to resolve ownerAddress; not accepting direct messages yet');
    return null;
  }
}

// Message streams: one jsonl per bot per group. Every message is recorded (not only mentions),
// so that when a bot is woken up it can see what happened in the group since its last reply.
function appendStream(event) {
  if (!isSafeGroupId(event.groupId)) return; // the file name comes from the group id: never write an invalid one
  const dir = join(dataDir, 'streams', event.agentId);
  mkdirSync(dir, { recursive: true });
  appendFileSync(pathInside(dir, `${event.groupId}.jsonl`), JSON.stringify(event) + '\n');
}

const seed = loadOrCreateSeed();
const client = new NodeClient({ baseUrl: config.nodeBaseUrl, logger });
if (!(await client.health())) {
  logger.error({ node: config.nodeBaseUrl }, 'node unreachable, exiting');
  process.exit(1);
}

/** @type {Map<string, Agent>} */
const agents = new Map();
for (const spec of config.agents) {
  const identity = deriveIdentity(seed, 'agent', spec.id);
  const agent = new Agent({
    id: spec.id,
    name: spec.name,
    aliases: spec.aliases ?? [],
    avatar: spec.avatar ?? null,
    identity,
    client,
    store: new AgentStore(join(dataDir, spec.id, 'state.json')),
    mediaRoot: join(dataDir, 'media', spec.id),
    mailCommands: spec.mailCommands === true,
    deviceId: loadOrCreateDeviceId(join(dataDir, spec.id)),
    wakeOnImage: spec.wakeOnImage === true,
    ownerPubkey: null, // filled in once the owner's public key is resolved
    logger,
    onGroupMessage: (event) => {
      appendStream(event);
      if (event.mentioned) {
        logger.info({ agent: event.agentId, group: event.groupName, text: event.text.slice(0, 60) }, 'mentioned');
      }
    }
  });
  agents.set(spec.id, agent);
}

const ownerPubkey = await resolveOwnerPubkey(client, agents.values().next().value);
// Chat groups (a mention from anyone counts) and all bot public keys: every bot needs these to tell
// group members apart from other AIs
const chatGroupIds = (config.chatGroups ?? []).map((g) => g.groupId);
const allBotPubkeys = [...agents.values()].map((a) => a.pubkey);
for (const agent of agents.values()) {
  chatGroupIds.forEach((id) => agent.chatGroups.add(id));
  allBotPubkeys.forEach((pk) => agent.botPubkeys.add(pk));
}
logger.info({ owner: owner.address ?? null }, 'owner resolved');

for (const agent of agents.values()) {
  agent.ownerPubkey = await resolveAgentOwner(config.agents.find((a) => a.id === agent.id), agent, ownerPubkey);
  await agent.start();
  logger.info({ agent: agent.id, name: agent.name, address: agent.address }, 'bot online');

  // Avatar changed: re-announce in joined groups so other members see the update
  for (const group of agent.store.listGroups().filter((g) => g.isMember)) {
    if (agent.store.announcedAvatar(group.groupId) === agent.avatar) continue;
    await agent.announceProfile(group.groupId).catch((error) => {
      logger.warn({ agent: agent.id, group: group.name, err: String(error) }, 'failed to update group profile');
    });
  }

  // First time online: say hello to the owner. The bot must appear in the owner's contacts before
  // the owner can add it to groups.
  const helloMark = join(dataDir, agent.id, 'hello-sent');
  if (!existsSync(helloMark) && agent.ownerPubkey) {
    try {
      await agent.sendPrivateText(agent.ownerPubkey, config.agents.find((a) => a.id === agent.id)?.hello ?? `你好,我是 ${agent.name}。把我拉进项目群,@${agent.name} 就能找到我。`);
      writeFileSync(helloMark, new Date().toISOString());
      logger.info({ agent: agent.id }, 'hello sent to owner');
    } catch (error) {
      logger.warn({ agent: agent.id, err: String(error) }, 'failed to send hello');
    }
  }
}

// ---------------- local HTTP API ----------------

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

// Personal memory database: AIs reach it through the tool bridge (bin/mem-mcp.js) via POST /mem/call.
// All permission checks live in MemService.
let mem = null;
try {
  mem = new MemService(openMemDb(join(dataDir, 'memdb', 'memory.db'), { ownerName: owner.name || '主人' }), {
    filesDir: join(dataDir, 'memdb', 'files'),
    timezone: owner.timezone || ''
  });
} catch (error) {
  logger.error({ err: String(error) }, 'failed to open memdb');
}

// Reminders: checked every 30 seconds. Due reminders are appended to the assistant's dm stream (the same
// queue as the owner's direct messages), and the waker wakes the assistant to deliver the reminder itself.
function reminderTick() {
  if (!mem) return;
  try {
    for (const ev of mem.reminderTick()) {
      if (!agents.has(ev.assistant)) { logger.warn({ assistant: ev.assistant }, 'reminder assistant is not running, skipping'); continue; }
      const r = ev.reminder;
      appendStream({
        agentId: ev.assistant, groupId: 'dm', groupName: '私聊', senderRaw: 'reminder', senderRole: 'reminder', senderName: '提醒',
        text: `[提醒到点] ${r.title}(第 ${r.attempt}/${r.max} 次)`, mentioned: true, reminder: r,
        clientMessageId: `reminder-${r.id}-${r.scheduled_at}-${r.attempt}`, at: Math.floor(Date.now() / 1000)
      });
      logger.info({ assistant: ev.assistant, title: r.title, attempt: r.attempt }, 'reminder due');
    }
  } catch (error) {
    logger.error({ err: String(error) }, 'reminder check failed');
  }
}
setInterval(reminderTick, 30 * 1000);
setTimeout(reminderTick, 5000);

const startedAt = Date.now();
// ── Local API protection ──
// Only local processes that can read <dataDir>/api-token may call the API. A web page in the browser can reach
// 127.0.0.1 too, so additionally: requests with an Origin header (browsers send it) are refused, the Host header must
// be the loopback address (defeats DNS rebinding), and POST bodies must be declared as JSON (no "simple" form posts).
const apiTokenPath = join(dataDir, 'api-token');
// Token file: missing, a symlink, or not 64 hex characters → regenerated; permissions too open → back to 600
function loadApiToken() {
  let ok = false;
  try {
    ok = !lstatSync(apiTokenPath).isSymbolicLink() && /^[0-9a-f]{64}$/.test(readFileSync(apiTokenPath, 'utf8').trim());
  } catch {}
  if (!ok) {
    rmSync(apiTokenPath, { force: true });
    writeFileSync(apiTokenPath, randomBytes(32).toString('hex'), { mode: 0o600 });
    logger.info({ path: apiTokenPath }, 'generated a new local API token');
  }
  restrictMode(apiTokenPath, 0o600);
  return Buffer.from(readFileSync(apiTokenPath, 'utf8').trim());
}
const apiToken = loadApiToken();
const allowedHosts = new Set([`127.0.0.1:${config.httpPort ?? 8790}`, `localhost:${config.httpPort ?? 8790}`, `[::1]:${config.httpPort ?? 8790}`]);

function rejectRequest(req) {
  if (req.headers.origin || req.headers['sec-fetch-site'] === 'cross-site') return 'origin_not_allowed';
  if (!process.env.AGENTS_HTTP_HOST && !allowedHosts.has(String(req.headers.host ?? '').toLowerCase())) return 'host_not_allowed';
  if (req.method === 'POST' && !/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) return 'content_type_must_be_json';
  const given = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
  if (given.length !== apiToken.length || !timingSafeEqual(given, apiToken)) return 'unauthorized';
  return null;
}

const server = createServer(async (req, res) => {
  const refused = rejectRequest(req);
  if (refused) {
    logger.warn({ path: req.url?.split('?')[0], reason: refused, origin: req.headers.origin ?? null }, 'local API request refused');
    return sendJson(res, refused === 'unauthorized' ? 401 : 403, { error: refused });
  }
  try {
    const url = new URL(req.url, 'http://localhost');
    const agentParam = url.searchParams.get('agent');

    if (req.method === 'GET' && url.pathname === '/status') {
      return sendJson(res, 200, {
        ok: [...agents.values()].every((a) => a.online),
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        agents: [...agents.values()].map((a) => ({
          id: a.id,
          name: a.name,
          address: a.address,
          online: a.online,
          offlineReason: a.offlineReason,
          groups: a.store.listGroups().filter((g) => g.isMember).map((g) => ({ id: g.groupId, name: g.name, joinKey: g.joinKey }))
        }))
      });
    }

    if (req.method === 'GET' && url.pathname === '/groups') {
      const agent = agents.get(agentParam);
      if (!agent) return sendJson(res, 404, { error: 'unknown_agent' });
      return sendJson(res, 200, { groups: agent.store.listGroups() });
    }

    // Group member list ?agent=&group=
    if (req.method === 'GET' && url.pathname === '/members') {
      const agent = agents.get(agentParam);
      if (!agent) return sendJson(res, 404, { error: 'unknown_agent' });
      return sendJson(res, 200, { members: agent.groupMembers(url.searchParams.get('group')) });
    }

    if (req.method === 'GET' && url.pathname === '/history') {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 30), 500);
      const events = readHistory(dataDir, agentParam, url.searchParams.get('group'), limit);
      return sendJson(res, 200, { events });
    }

    if (req.method === 'POST' && url.pathname === '/send') {
      const body = await readBody(req);
      const agent = agents.get(body.agent);
      if (!agent) return sendJson(res, 404, { error: 'unknown_agent' });
      const text = String(body.text ?? '').trim();
      if (!body.groupId || !text) return sendJson(res, 400, { error: 'groupId_and_text_required' });
      const result = await agent.sendGroupText(body.groupId, text, { mentionOwner: body.mentionOwner === true });
      return sendJson(res, 200, { ok: true, ...result });
    }

    // Direct message to the owner as the bot (proactive notifications, e.g. a long task finished)
    if (req.method === 'POST' && url.pathname === '/dm') {
      const body = await readBody(req);
      const agent = agents.get(body.agent);
      if (!agent) return sendJson(res, 404, { error: 'unknown_agent' });
      const text = String(body.text ?? '').trim();
      if (!text) return sendJson(res, 400, { error: 'text_required' });
      await agent.sendPrivateText(agent.ownerPubkey, text, { origin: body.origin ?? null });
      return sendJson(res, 200, { ok: true });
    }

    // Direct voice message {agent, text}: synthesized with the voice in config.voice[agent] and sent to the
    // owner in the app's voice message format
    if (req.method === 'POST' && url.pathname === '/dm-voice') {
      const body = await readBody(req);
      const agent = agents.get(body.agent);
      if (!agent) return sendJson(res, 404, { error: 'unknown_agent' });
      const voice = JSON.parse(readFileSync(configPath, 'utf8')).voice?.[body.agent];
      if (!voice) return sendJson(res, 400, { error: 'no_voice_configured' });
      const text = String(body.text ?? '').trim();
      if (!text) return sendJson(res, 400, { error: 'text_required' });
      // voiceId / speed: temporary overrides for trying voices (config unchanged); languageBoost: spoken language
      // (the translator passes the target language)
      const tts = await synthesizeMiniMax(text, { ...voice, ...(body.voiceId ? { voiceId: body.voiceId } : {}), ...(body.speed ? { speed: Number(body.speed) } : {}), ...(body.languageBoost ? { languageBoost: body.languageBoost } : {}) });
      const message = toVoiceMessage(tts.mp3);
      // Longer than 60 seconds: don't send; the caller shortens it or sends text instead
      if (message.durationMs > VOICE_MAX_MS) {
        logger.warn({ agent: body.agent, ms: message.durationMs, chars: tts.chars }, 'voice message over 60 seconds; not sent');
        return sendJson(res, 413, { error: 'voice_too_long', durationMs: message.durationMs, maxMs: VOICE_MAX_MS, hint: 'voice messages are at most 60 seconds: shorten the script (under ~200 CJK characters) or send text' });
      }
      const result = await agent.sendPrivateVoice(agent.ownerPubkey, message, { text, origin: body.origin ?? null });
      logger.info({ agent: body.agent, chars: tts.chars, ms: result.durationMs }, 'sent direct voice message');
      return sendJson(res, 200, { ok: true, durationMs: result.durationMs, billedChars: tts.chars });
    }

    // Direct image to the owner {agent, path} (compressed to the direct-message spec)
    if (req.method === 'POST' && url.pathname === '/dm-image') {
      const body = await readBody(req);
      const agent = agents.get(body.agent);
      if (!agent) return sendJson(res, 404, { error: 'unknown_agent' });
      if (!body.path) return sendJson(res, 400, { error: 'path_required' });
      const result = await agent.sendPrivateImage(agent.ownerPubkey, body.path, { origin: body.origin ?? null });
      return sendJson(res, 200, { ok: true, ...result });
    }

    // Group image {agent, groupId, path}: path is a local image file, compressed to the group image spec
    if (req.method === 'POST' && url.pathname === '/send-image') {
      const body = await readBody(req);
      const agent = agents.get(body.agent);
      if (!agent) return sendJson(res, 404, { error: 'unknown_agent' });
      if (!body.groupId || !body.path) return sendJson(res, 400, { error: 'groupId_and_path_required' });
      const result = await agent.sendGroupImage(body.groupId, body.path);
      return sendJson(res, 200, { ok: true, ...result });
    }

    // Mark a group as left {agent, groupId} (removed without a notification; cleans up stale status entries)
    if (req.method === 'POST' && url.pathname === '/leave') {
      const body = await readBody(req);
      const agent = agents.get(body.agent);
      if (!agent) return sendJson(res, 404, { error: 'unknown_agent' });
      return sendJson(res, 200, { ok: agent.store.markLeft(body.groupId) });
    }

    // Change group nickname {agent, groupId, displayName}
    if (req.method === 'POST' && url.pathname === '/profile') {
      const body = await readBody(req);
      const agent = agents.get(body.agent);
      if (!agent) return sendJson(res, 404, { error: 'unknown_agent' });
      await agent.setGroupNickname(body.groupId, body.displayName);
      return sendJson(res, 200, { ok: true, displayName: agent.displayNameIn(body.groupId) });
    }

    if (req.method === 'POST' && url.pathname === '/hello') {
      const body = await readBody(req);
      const agent = agents.get(body.agent);
      if (!agent) return sendJson(res, 404, { error: 'unknown_agent' });
      await agent.sendPrivateText(agent.ownerPubkey, `你好,我是 ${agent.name}。`);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'GET' && url.pathname === '/mem/family') {
      if (!mem) return sendJson(res, 503, { error: 'memdb_unavailable' });
      return sendJson(res, 200, { family: mem.family(url.searchParams.get('self') || 'owner') });
    }

    if (req.method === 'GET' && url.pathname === '/mem/reminder-due') {
      if (!mem) return sendJson(res, 503, { error: 'memdb_unavailable' });
      const q = url.searchParams;
      return sendJson(res, 200, { due: mem.reminderStillDue(q.get('id'), q.get('scheduled'), Number(q.get('attempt'))) });
    }

    if (req.method === 'POST' && url.pathname === '/mem/call') {
      if (!mem) return sendJson(res, 503, { error: 'memdb_unavailable' });
      const body = await readBody(req);
      try {
        return sendJson(res, 200, { ok: true, result: mem.call(body.identity, body.tool, body.args ?? {}) });
      } catch (error) {
        if (error instanceof MemError) return sendJson(res, 200, { ok: false, error: error.message });
        throw error;
      }
    }

    sendJson(res, 404, { error: 'not_found' });
  } catch (error) {
    logger.error({ err: String(error), url: req.url }, 'HTTP handler error');
    sendJson(res, 500, { error: String(error.message ?? error) });
  }
});

const port = Number(config.httpPort ?? 8790);
// Inside a container, listen on 0.0.0.0 so the host port mapping works; locally default to 127.0.0.1 only
const host = process.env.AGENTS_HTTP_HOST ?? '127.0.0.1';
server.listen(port, host, () => logger.info({ listen: `${host}:${port}` }, 'local HTTP API started'));

async function shutdown(signal) {
  logger.info({ signal }, 'shutting down');
  for (const agent of agents.values()) agent.stop();
  server.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => logger.error({ err: String(reason) }, 'unhandledRejection'));
