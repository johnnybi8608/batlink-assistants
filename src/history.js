// Read the message stream (one jsonl per bot per group). Only the tail is read, so large files are
// never loaded into memory in full.
import { existsSync, openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { isSafeGroupId, pathInside } from './safe-id.js';

const TAIL_BYTES = 512 * 1024;

export function streamPath(dataDir, agentId, groupId) {
  if (!isSafeGroupId(groupId)) throw new Error('invalid_group_id');
  return pathInside(join(dataDir, 'streams', agentId), `${groupId}.jsonl`);
}

/** The latest `limit` events, oldest first */
export function readHistory(dataDir, agentId, groupId, limit = 30) {
  if (!agentId || !isSafeGroupId(groupId)) return [];
  const path = streamPath(dataDir, agentId, groupId);
  if (!existsSync(path)) return [];
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    if (start > 0) lines.shift(); // the first line may be cut off
    const events = [];
    for (const line of lines) {
      try { events.push(JSON.parse(line)); } catch { /* skip malformed lines */ }
    }
    return events.slice(-limit);
  } finally {
    closeSync(fd);
  }
}
