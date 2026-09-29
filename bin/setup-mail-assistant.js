#!/usr/bin/env node
// Create the mail assistant's session (旺财 by default): Claude with zero tools (--tools "" and no MCP
// servers), so it can only output text. Its working directory is an empty folder under
// <dataDir>/mail/assistant-cwd, so it never picks up any project's CLAUDE.md.
// It then writes (or replaces) the "mailbot" waker entry in config.json → wakers, which makes the waker
// route the owner's private messages to this bot (config.mail.agent) into that session.
//
// A general setup script may run this as one of its steps; it is kept as a standalone tool so the mail
// assistant can be (re)created on its own, e.g. with --recreate when its session has grown too long.
//
// Usage: node bin/setup-mail-assistant.js [--recreate]
// Afterwards the services are reinstalled (the waker picks up the new session, mailwatch starts).

import { readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { run, CLAUDE_MODEL_ARGS, NO_TOOLS_ARGS, CLAUDE_BIN } from '../src/proc.js';
import { mailAssistantInitPrompt, mailAssistantName } from '../src/mail/assistant.js';
import { CONFIG_PATH, mailSettings, dataDirOf } from '../src/mail/store.js';
import { restartService } from '../src/service.js';
import { spawnSync } from 'node:child_process';

const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const agent = mailSettings(config).agent;
const dataDir = dataDirOf(config);
const workDir = join(dataDir, 'mail', 'assistant-cwd');
mkdirSync(workDir, { recursive: true });

if (!(config.agents ?? []).some((a) => a.id === agent)) {
  console.warn(`⚠ config.agents has no bot with id "${agent}" (config.mail.agent). Add it (with "mailCommands": true) or the assistant cannot receive messages.`);
}

const existing = (config.wakers ?? []).find((w) => w.engine === 'mailbot');
if (existing && !process.argv.includes('--recreate')) {
  console.log(`The mail assistant already exists (session ${existing.sessionId}); skipped. Use --recreate to create a new one.`);
  process.exit(0);
}

const sessionId = randomUUID();
const res = await run(CLAUDE_BIN, ['-p', '--session-id', sessionId, ...NO_TOOLS_ARGS, ...CLAUDE_MODEL_ARGS, '--output-format', 'stream-json', '--verbose'], {
  input: mailAssistantInitPrompt(config), cwd: workDir, timeoutMs: 5 * 60 * 1000
});
let init = null;
for (const line of res.stdout.split('\n')) { try { const e = JSON.parse(line); if (e.type === 'system' && e.subtype === 'init') init = e; } catch {} }
if (/Not logged in|Please run \/login/i.test(res.stdout + res.stderr)) { console.error('✗ The Claude CLI is not logged in (or this is running inside a sandbox). Run `claude` once and log in.'); process.exit(1); }
if (res.code !== 0 || !init) { console.error(`✗ Creating the session failed (${res.code}): ${(res.stderr || res.stdout).slice(-400)}`); process.exit(1); }
if (init.tools?.length || init.mcp_servers?.length) { console.error(`✗ The session unexpectedly has tools, not using it: ${JSON.stringify(init.tools)} ${JSON.stringify(init.mcp_servers)}`); process.exit(1); }

const fresh = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
fresh.wakers = (fresh.wakers ?? []).filter((w) => w.engine !== 'mailbot');
fresh.wakers.push({ project: mailAssistantName(fresh), kind: 'dm', agent, engine: 'mailbot', group: 'dm', sessionId, workDir });
const tmp = `${CONFIG_PATH}.tmp`;
writeFileSync(tmp, JSON.stringify(fresh, null, 2) + '\n');
renameSync(tmp, CONFIG_PATH);
mkdirSync(dataDir, { recursive: true });
appendFileSync(join(dataDir, 'waker.log'), JSON.stringify({ t: new Date().toISOString(), msg: 'setup-mail-assistant', sessionId }) + '\n');

// mailwatch only runs when a mailbox is configured: reinstall the services so it starts and the waker reloads
const install = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'install-service.js')], { stdio: 'inherit' });
const restarted = install.status === 0 || restartService('waker');
console.log(`✓ Mail assistant ready: session ${sessionId} (verified: tools ${JSON.stringify(init.tools)}, MCP ${JSON.stringify(init.mcp_servers)})`);
if (!restarted) console.log('  Restart the waker (bin/waker.js) so it picks up the new session.');
