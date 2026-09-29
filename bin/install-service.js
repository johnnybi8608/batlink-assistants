#!/usr/bin/env node
// Installs (or removes) the launchd services that keep the assistants running in the background (macOS).
//   node bin/install-service.js            install / update and start
//   node bin/install-service.js --remove   stop and remove
// Plists go to ~/Library/LaunchAgents/<label>.plist; logs to <dataDir>/*.stdout.log.
// mailwatch is only installed when config.mail has at least one account.

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { LABELS } from '../src/service.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = resolve(process.env.AGENTS_CONFIG ?? join(root, 'config.json'));
const remove = process.argv.includes('--remove');
const agentsDir = join(homedir(), 'Library', 'LaunchAgents');
const uid = process.getuid();
const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
const dataDir = isAbsolute(config.dataDir ?? '') ? config.dataDir : join(root, config.dataDir ?? 'data');
const hasMail = Array.isArray(config.mail?.accounts) ? config.mail.accounts.length > 0 : Array.isArray(config.mail) && config.mail.length > 0;

const SERVICES = [
  { name: 'daemon', script: 'src/daemon.js', log: 'daemon' },
  { name: 'waker', script: 'bin/waker.js', log: 'waker' },
  ...(hasMail ? [{ name: 'mailwatch', script: 'bin/mailwatch.js', log: 'mailwatch' }] : [])
];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const plist = ({ label, script, log }) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${esc(label)}</string>
  <key>ProgramArguments</key>
  <array><string>${esc(process.execPath)}</string><string>${esc(join(root, script))}</string></array>
  <key>WorkingDirectory</key><string>${esc(root)}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>${process.env.AGENTS_CONFIG ? `<key>AGENTS_CONFIG</key><string>${esc(configPath)}</string>` : ''}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${esc(join(dataDir, `${log}.stdout.log`))}</string>
  <key>StandardErrorPath</key><string>${esc(join(dataDir, `${log}.stdout.log`))}</string>
</dict>
</plist>
`;

const launchctl = (...a) => { try { execFileSync('launchctl', a, { stdio: 'ignore' }); return true; } catch { return false; } };

mkdirSync(agentsDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
for (const name of Object.keys(LABELS)) {
  const label = LABELS[name];
  const path = join(agentsDir, `${label}.plist`);
  launchctl('bootout', `gui/${uid}/${label}`);
  const svc = SERVICES.find((s) => s.name === name);
  if (remove || !svc) {
    if (existsSync(path)) { rmSync(path); console.log(`removed ${label}`); }
    continue;
  }
  writeFileSync(path, plist({ label, ...svc }));
  const ok = launchctl('bootstrap', `gui/${uid}`, path);
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : ` (launchctl bootstrap failed; try: launchctl bootstrap gui/${uid} ${path})`}`);
}
if (!remove && !existsSync(configPath)) console.log('⚠️ config.json not found — run `npm run setup` first');
