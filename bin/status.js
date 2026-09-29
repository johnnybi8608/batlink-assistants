#!/usr/bin/env node
// Show bot status: online or not, address, and which groups it is in (group ids are used by listen/send)
import { PORT, localFetch } from '../src/local.js';
const port = PORT;
const res = await localFetch(`/status`).catch(() => null);
if (!res?.ok) { console.log('daemon is not running'); process.exit(1); }
const s = await res.json();
for (const a of s.agents) {
  console.log(`${a.online ? '🟢' : '🔴'} ${a.name}  ${a.address}`);
  for (const g of a.groups) console.log(`     group "${g.name}"  ${g.id}`);
  if (!a.groups.length) console.log('     (not in any group yet)');
}
