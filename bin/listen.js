#!/usr/bin/env node
// Watches one bot's message stream for a group and prints one JSON line per wake-up: only messages
// that mention this bot and come from the owner (or, in chat groups, from anyone; or a due reminder).
// Meant to be consumed by a long-running AI session (e.g. a background monitor).
//
// Each line carries every message in the group since the bot was last called, so messages that did not
// mention it (e.g. the owner talking to another bot) are visible when it wakes up.
//
// Usage: node bin/listen.js --agent zhaoxiaoliu --group <groupId>
//        node bin/listen.js --agent zhaoxiaoliu --group all      # every group this bot is in
//        node bin/listen.js --agent zhaoxiaoliu --group <groupId> --once [--timeout <seconds>]

import { existsSync, readdirSync, openSync, readSync, closeSync, statSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readHistory } from '../src/history.js';
import { DATA_DIR, requireAgent } from '../src/local.js';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, all) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), all[i + 1]]);
    return acc;
  }, [])
);
const agentId = requireAgent(args.agent, 'usage: node bin/listen.js --agent <bot id> --group <group id|dm>');
const groupArg = args.group ?? 'all';
const dataDir = DATA_DIR;
const dir = join(dataDir, 'streams', agentId);
// Context = ALL messages in the group since this bot was last called (including other AIs' output,
// excluding its own messages), not truncated. When it is too long, only a summary is inlined; the full
// context is written to a file and the event carries its path for the session to read.
const CONTEXT_MAX = 500;
const INLINE_CHARS_MAX = 12000;
const contextDir = join(dataDir, 'context', agentId);

/** @type {Map<string, {offset: number, rest: string}>} */
const cursors = new Map();

function targetFiles() {
  if (groupArg !== 'all') return [join(dir, `${groupArg}.jsonl`)];
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => join(dir, f));
}

// The read position is persisted per group: if the watcher is restarted, mentions that arrive in the gap
// must not be lost. Without a saved position (first run) it starts at the end of the file: only new
// messages, no replay of history.
const streamCursorDir = join(dataDir, 'cursors', agentId);
const streamCursorFile = (file) => join(streamCursorDir, `${file.split('/').pop().replace(/\.jsonl$/, '')}.stream.json`);
function loadStreamCursor(file) {
  try {
    const offset = JSON.parse(readFileSync(streamCursorFile(file), 'utf8')).offset;
    if (Number.isInteger(offset) && offset <= statSync(file).size) return offset;
  } catch {}
  return statSync(file).size;
}
function saveStreamCursor(file, offset) {
  try {
    mkdirSync(streamCursorDir, { recursive: true });
    writeFileSync(streamCursorFile(file), JSON.stringify({ offset }));
  } catch {}
}
const isOnceMode = process.argv.includes('--once');
if (!isOnceMode) {
  for (const file of targetFiles()) {
    if (existsSync(file)) cursors.set(file, { offset: loadStreamCursor(file), rest: '' });
  }
}

function contextFor(event) {
  const history = readHistory(dataDir, agentId, event.groupId, CONTEXT_MAX + 50);
  const idx = history.findIndex((e) => e.clientMessageId === event.clientMessageId);
  const before = idx >= 0 ? history.slice(0, idx) : history;
  // Start after the last message that called this bot (not after its last reply): when two AIs are
  // called at the same time, the other one's reply may arrive a few seconds earlier and would be missed
  // if we cut at "my last reply". The bot's own messages are left out; the session already remembers them.
  let start = 0;
  for (let i = before.length - 1; i >= 0; i -= 1) {
    if (before[i].mentioned && (before[i].senderRole === 'owner' || before[i].openMention || before[i].reminder)) { start = i + 1; break; }
  }
  // `origin` marks messages sent by the bot account but not written by the AI session (e.g. mail
  // notifications); those are included
  return before.slice(start).filter((e) => e.senderRole !== 'self' || e.origin).slice(-CONTEXT_MAX).map((e) => ({
    from: e.senderRole === 'owner' ? '我' : e.origin ? `${e.senderName}·${e.origin}` : e.senderName,
    at: new Date(e.at * 1000).toISOString(),
    text: e.text,
    // In chat groups each speaker must be distinguishable: role, whether it is a bot, wallet address
    ...(e.openMention ? { role: e.senderRole, fromBot: Boolean(e.fromBot), address: e.senderAddress ?? null } : {})
  }));
}

function emit(event) {
  const context = contextFor(event);
  const line = {
    type: 'batlink_mention',
    agent: agentId,
    group: event.groupId,
    groupName: event.groupName,
    text: event.text,
    context,
    at: new Date(event.at * 1000).toISOString(),
    ...(event.reminder ? { reminder: event.reminder } : {}),
    ...(event.openMention ? { sender: { name: event.senderName, role: event.senderRole, fromBot: Boolean(event.fromBot), address: event.senderAddress ?? null } } : {})
  };
  const inlineSize = context.reduce((sum, c) => sum + c.text.length, 0);
  if (inlineSize > INLINE_CHARS_MAX) {
    mkdirSync(contextDir, { recursive: true });
    const file = join(contextDir, `${event.clientMessageId ?? Date.now()}.json`);
    writeFileSync(file, JSON.stringify(context, null, 2));
    line.context = context.map((c) => ({ from: c.from, at: c.at, chars: c.text.length, preview: c.text.slice(0, 120) }));
    line.contextFile = file; // full context; the session must read this file before answering
  }
  process.stdout.write(JSON.stringify(line) + '\n');
}

function poll() {
  for (const file of targetFiles()) {
    if (!existsSync(file)) continue;
    const cursor = cursors.get(file) ?? { offset: 0, rest: '' }; // new file (just joined a group): read from the start
    const size = statSync(file).size;
    if (size < cursor.offset) cursor.offset = 0; // file was truncated / recreated
    if (size > cursor.offset) {
      const fd = openSync(file, 'r');
      const buf = Buffer.alloc(size - cursor.offset);
      readSync(fd, buf, 0, buf.length, cursor.offset);
      closeSync(fd);
      cursor.offset = size;
      const chunk = cursor.rest + buf.toString('utf8');
      const lines = chunk.split('\n');
      cursor.rest = lines.pop() ?? '';
      for (const raw of lines) {
        if (!raw.trim()) continue;
        let event;
        try { event = JSON.parse(raw); } catch { continue; }
        if (event.mentioned && (event.senderRole === 'owner' || event.openMention || event.reminder)) emit(event);
      }
      // Only persist up to the last complete line; a partial line waits for the next poll
      saveStreamCursor(file, cursor.offset - Buffer.byteLength(cursor.rest, 'utf8'));
    }
    cursors.set(file, cursor);
  }
}

// ---------- --once mode (for AI sessions that cannot run a background watcher) ----------
// Waits for the next message that calls this bot, prints one JSON line and exits; the session replies
// and runs it again, forming a loop.
// The position is stored in data/cursors/<agent>/<groupId>.json, so mentions that arrive while replying
// are not lost and are returned immediately on the next run.
// --timeout <seconds>: if nobody calls within that time, print {"type":"timeout"} and exit 0; just run again.
function runOnce() {
  if (groupArg === 'all') {
    process.stderr.write('--once requires --group <groupId>\n');
    process.exit(2);
  }
  const file = join(dir, `${groupArg}.jsonl`);
  const cursorDir = join(dataDir, 'cursors', agentId);
  const cursorFile = join(cursorDir, `${groupArg}.json`);
  mkdirSync(cursorDir, { recursive: true });
  let offset;
  try {
    offset = JSON.parse(readFileSync(cursorFile, 'utf8')).offset;
  } catch {
    offset = existsSync(file) ? statSync(file).size : 0; // first run: only messages from now on
  }
  const saveCursor = () => writeFileSync(cursorFile, JSON.stringify({ offset }));
  saveCursor();

  const timeoutSec = Number(args.timeout ?? 0);
  const deadline = timeoutSec > 0 ? Date.now() + timeoutSec * 1000 : Infinity;

  const tick = () => {
    if (existsSync(file)) {
      const size = statSync(file).size;
      if (size < offset) offset = 0;
      if (size > offset) {
        const fd = openSync(file, 'r');
        const buf = Buffer.alloc(size - offset);
        readSync(fd, buf, 0, buf.length, offset);
        closeSync(fd);
        const text = buf.toString('utf8');
        let consumed = 0;
        let newline;
        // Consume line by line; the cursor only advances past complete lines, and stops right after a hit
        while ((newline = text.indexOf('\n', consumed)) >= 0) {
          const raw = text.slice(consumed, newline);
          consumed = newline + 1;
          let event = null;
          try { event = raw.trim() ? JSON.parse(raw) : null; } catch { event = null; }
          if (event && event.mentioned && (event.senderRole === 'owner' || event.openMention || event.reminder)) {
            offset += Buffer.byteLength(text.slice(0, consumed), 'utf8');
            saveCursor();
            emit(event);
            process.exit(0);
          }
        }
        offset += Buffer.byteLength(text.slice(0, consumed), 'utf8');
        saveCursor();
      }
    }
    if (Date.now() >= deadline) {
      process.stdout.write(JSON.stringify({ type: 'timeout', agent: agentId, group: groupArg }) + '\n');
      process.exit(0);
    }
    setTimeout(tick, 700);
  };
  tick();
}

if (args.once !== undefined || process.argv.includes('--once')) {
  runOnce();
} else {
  setInterval(poll, 700);
  process.stderr.write(`[listen] agent=${agentId} group=${groupArg} dir=${dir}\n`);
}
