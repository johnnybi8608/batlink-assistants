#!/usr/bin/env node
// Switches which CLI a persona assistant (灵犀 by default) runs on: Codex or the Grok CLI. Prompt, memdb, rules and
// voice are identical on both; each backend keeps its own session, so switching back and forth loses nothing.
// The waker is restarted once no assistant is in the middle of a reply.
// Usage: node bin/assistant-backend.js lingxi grok                 switch to Grok (first time: a fresh session)
//        node bin/assistant-backend.js lingxi codex                switch back to Codex
//        node bin/assistant-backend.js lingxi grok --new-session   start a brand-new Grok session
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { LABELS, restartService } from '../src/service.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = resolve(process.env.AGENTS_CONFIG ?? join(root, 'config.json'));
const [agent, backend] = process.argv.slice(2);
if (!agent || !['grok', 'codex'].includes(backend)) {
  console.error('usage: node bin/assistant-backend.js <persona agent id> <grok|codex> [--new-session]');
  process.exit(2);
}
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const waker = (config.wakers ?? []).find((w) => w.agent === agent && w.engine === 'persona');
if (!waker) { console.error(`no persona assistant "${agent}" in config.wakers`); process.exit(1); }
waker.backend = backend;
if (backend === 'grok' && (!waker.grokSessionId || process.argv.includes('--new-session'))) waker.grokSessionId = randomUUID();
const tmp = `${configPath}.tmp`;
writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n');
renameSync(tmp, configPath);
console.log(`✓ ${agent} now runs on ${backend}${backend === 'grok' ? ` (session ${waker.grokSessionId})` : ''}`);

// Wait (up to 5 min) until no AI is replying, then restart the waker
const busy = () => {
  const pid = execSync('launchctl list').toString().split('\n').find((l) => l.endsWith(`\t${LABELS.waker}`))?.split('\t')[0];
  if (!pid || pid === '-') return false;
  let kids = '';
  try { kids = execSync(`pgrep -P ${pid} -fl .`).toString(); } catch {}
  return kids.split('\n').some((l) => l.trim() && !l.includes('listen.js'));
};
for (let i = 0; i < 60 && busy(); i += 1) execSync('sleep 5');
if (busy()) { console.log('⚠️ an assistant is still replying; waker not restarted — restart it later to apply'); process.exit(0); }
console.log(restartService('waker') ? '✓ waker restarted; change applied' : '⚠️ waker not running (npm run install-service)');
