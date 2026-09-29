#!/usr/bin/env node
// Change a bot's nickname in one group (calls the local daemon's /profile).
// Usage: node bin/nickname.js --agent zhaoxiaoliu --group <groupId> "new nickname"
import { PORT, requireAgent, localFetch } from '../src/local.js';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const agent = requireAgent(opt('agent'));
const groupId = opt('group');
const name = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')).join(' ').trim();
if (!groupId || !name) {
  console.error('Usage: node bin/nickname.js --agent <agentId> --group <groupId> "new nickname"');
  process.exit(2);
}
const res = await localFetch(`/profile`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ agent, groupId, displayName: name })
});
const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`Changing nickname failed: ${res.status} ${JSON.stringify(body)}`);
  process.exit(1);
}
console.log(`Nickname changed to "${body.displayName}" (${agent} @ ${groupId})`);
