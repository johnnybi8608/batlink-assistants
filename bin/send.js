#!/usr/bin/env node
// Send a message to a group as one of the bots (calls the local daemon's /send).
// The text is read from stdin first, so multi-line replies with quotes or code need no shell escaping.
//
// Usage: echo "reply text" | node bin/send.js --agent zhaoxiaoliu --group <groupId>
//        node bin/send.js --agent zhaoxiaoliu --group <groupId> "one line"
import { PORT, requireAgent, localFetch } from '../src/local.js';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const agent = requireAgent(opt('agent'), 'usage: echo "text" | node bin/send.js --agent <bot id> --group <group id>');
const groupId = opt('group');
const positional = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const port = PORT;

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const text = (positional.join(' ') || (await readStdin())).trim();
if (!groupId || !text) {
  console.error('Usage: echo "text" | node bin/send.js --agent <agentId> --group <groupId>');
  process.exit(2);
}
const res = await localFetch(`/send`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ agent, groupId, text })
});
const body = await res.json().catch(() => ({}));
if (!res.ok) { console.error('Send failed:', res.status, JSON.stringify(body)); process.exit(1); }
console.log(`Sent (${agent} -> ${groupId}, delivered to ${body.delivered} members)`);
