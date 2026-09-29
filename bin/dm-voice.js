#!/usr/bin/env node
// Send a direct voice message to the bot's owner: the text is synthesized with the voice configured in
// config.json -> voice.<agentId>. The text is read from stdin.
// Usage: echo "what to say" | node bin/dm-voice.js --agent lingxi
import { PORT, requireAgent, localFetch } from '../src/local.js';
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const agent = requireAgent(opt('agent'), 'usage: echo "text" | node bin/dm-voice.js --agent <bot id>');
const positional = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const port = PORT;
async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = []; for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}
const text = (positional.join(' ') || (await readStdin())).trim();
if (!text) { console.error('Usage: echo "what to say" | node bin/dm-voice.js --agent <agentId>'); process.exit(2); }
const res = await localFetch(`/dm-voice`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent, text }), signal: AbortSignal.timeout(120000)
});
const body = await res.json().catch(() => ({}));
if (!res.ok) { console.error('Sending voice failed:', res.status, JSON.stringify(body)); process.exit(1); }
console.log(`Voice sent (${agent} -> owner, ${Math.round(body.durationMs / 1000)}s)`);
