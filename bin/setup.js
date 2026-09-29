#!/usr/bin/env node
// First-run setup. Creates config.json, the memdb, the assistants' AI sessions and the launchd services.
// Safe to run again: existing config values and sessions are kept (use --recreate <agent> to rebuild a session).
//
//   npm run setup
//   node bin/setup.js --owner 0x… --name Alex [--work-dir ~/Projects] [--work-engine claude|codex]
//                     [--only lingxi,zhaoxiaoliu,qingyue] [--no-service] [--yes]
//
// The bots' Batlink accounts are not created here: the daemon derives them from a random master seed on its first
// start (data/master-seed.key), brings them online and sends you a hello from each one.

import { callNameFor } from '../src/persona.js';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { run, CLAUDE_BIN, CODEX_BIN } from '../src/proc.js';
import { createSession, workAssistantInitPrompt, personaInitPrompt, standardWakers } from '../src/assistants.js';
import { findSecret } from '../src/secrets.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = resolve(process.env.AGENTS_CONFIG ?? join(root, 'config.json'));
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const flag = (name) => args.includes(`--${name}`);
const yes = flag('yes');
const say = (m) => console.log(m);
const step = (m) => console.log(`\n▸ ${m}`);
const expandHome = (p) => (p?.startsWith('~') ? join(homedir(), p.slice(1)) : p);

const rl = yes ? null : createInterface({ input: stdin, output: stdout });
async function ask(question, fallback = '') {
  if (!rl) return fallback;
  const answer = (await rl.question(`${question}${fallback ? ` [${fallback}]` : ''}: `)).trim();
  return answer || fallback;
}

// ---------- 1. config.json ----------
step('1/5 config.json');
const example = JSON.parse(readFileSync(join(root, 'config.example.json'), 'utf8'));
const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : structuredClone(example);
config.owner ??= {};
say('Your Batlink address is on the "Me" page of the Batlink app (0x followed by 40 hex characters).');
say('你的 Batlink 地址在 App「我的」页面,0x 开头共 42 位。');
let address = opt('owner') ?? config.owner.address;
if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? '')) address = await ask('Your Batlink address / 你的 Batlink 地址', '');
if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? '')) {
  console.error('✗ a Batlink address looks like 0x + 40 hex characters. Run setup again with --owner 0x…');
  process.exit(1);
}
config.owner.address = address;
config.owner.name = opt('name') ?? (config.owner.name && config.owner.name !== '主人' ? config.owner.name
  : await ask('Your name or nickname (not your legal name; each assistant has its own way of addressing you, see the end) / 你的名字或昵称(不是真名;每个助理怎么称呼你见最后)', config.owner.name || '主人'));
config.owner.timezone ??= '';
for (const key of ['nodeBaseUrl', 'dataDir', 'httpPort', 'logLevel', 'translator', 'projectAgents']) config[key] ??= example[key];
config.agents ??= example.agents;
config.voice ??= {};
config.wakers ??= [];
const dataDir = isAbsolute(config.dataDir) ? config.dataDir : join(root, config.dataDir);
mkdirSync(dataDir, { recursive: true });

const wanted = (opt('only') ?? 'lingxi,zhaoxiaoliu,qingyue').split(',').map((s) => s.trim()).filter(Boolean);
const workDir = resolve(expandHome(opt('work-dir') ?? (config.wakers.find((w) => w.agent === 'zhaoxiaoliu' && w.kind === 'dm')?.workDir
  ?? await ask('赵小六\'s work folder (where your projects are) / 工作助理的工作目录', join(homedir(), 'Projects')))));
const workEngine = opt('work-engine') ?? config.wakers.find((w) => w.agent === 'zhaoxiaoliu' && w.kind === 'dm')?.engine ?? 'claude';
const save = () => {
  const tmp = `${configPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, configPath);
};
save();
say(`✓ ${configPath}`);

// ---------- 2. memdb ----------
step('2/5 private database (memdb)');
const mem = await run(process.execPath, [join(root, 'bin', 'memdb.js'), 'init'], { cwd: root });
say(mem.code === 0 ? `✓ memdb ready (${join(dataDir, 'memdb', 'memory.db')})` : `✗ memdb init failed:\n${mem.stderr || mem.stdout}`);

// ---------- 3. sessions ----------
step('3/5 AI sessions');
const haveClaude = existsSync(CLAUDE_BIN);
const haveCodex = existsSync(CODEX_BIN);
say(`Claude Code CLI: ${haveClaude ? CLAUDE_BIN : 'not found (https://docs.claude.com/claude-code)'}`);
say(`Codex CLI:       ${haveCodex ? CODEX_BIN : 'not found (https://github.com/openai/codex)'}`);
const defaults = standardWakers({ dataDir, workDir, workEngine });
const recreate = opt('recreate');
for (const agent of wanted) {
  const template = defaults[agent];
  if (!template) { say(`• ${agent}: not a standard assistant; skipped`); continue; }
  const existing = config.wakers.find((w) => w.kind === 'dm' && w.agent === agent);
  if (existing && (existing.sessionId || existing.engine === 'translator') && recreate !== agent) {
    say(`• ${agent}: already set up; kept`);
    continue;
  }
  const entry = { ...template, ...(existing ?? {}) };
  const name = config.agents.find((a) => a.id === agent)?.name ?? agent;
  try {
    if (entry.engine === 'persona') {
      if (!haveCodex) throw new Error('needs the Codex CLI');
      entry.sessionId = await createSession({ engine: 'codex', prompt: personaInitPrompt({ name }), cwd: entry.workDir, readOnly: true, search: true });
    } else if (entry.engine === 'claude' || entry.engine === 'codex') {
      if (entry.engine === 'claude' && !haveClaude) throw new Error('needs the Claude Code CLI (or use --work-engine codex)');
      if (entry.engine === 'codex' && !haveCodex) throw new Error('needs the Codex CLI');
      entry.sessionId = await createSession({ engine: entry.engine, prompt: workAssistantInitPrompt({ root, agent, name, workDir: entry.workDir }), cwd: entry.workDir, readOnly: true });
    } else {
      mkdirSync(entry.workDir, { recursive: true });
    }
    config.wakers = config.wakers.filter((w) => !(w.kind === 'dm' && w.agent === agent));
    config.wakers.push(entry);
    save();
    say(`✓ ${name} (${agent}): ${entry.sessionId ? `session ${entry.sessionId}` : 'ready'}`);
  } catch (error) {
    say(`✗ ${name} (${agent}): ${error.message}`);
  }
}

// ---------- 4. services ----------
step('4/5 background services (launchd)');
if (flag('no-service')) {
  say('skipped (--no-service). Install later with: npm run install-service');
} else {
  const res = await run(process.execPath, [join(root, 'bin', 'install-service.js')], { cwd: root });
  say((res.stdout || res.stderr).trim());
}

// ---------- 5. keys ----------
step('5/5 API keys (optional features)');
const keys = [
  ['xai', '清越 translator (xAI / Grok) — or point config.translator at another OpenAI-compatible API'],
  ['openai', 'voice-message transcription'],
  ['minimax', 'voice replies (text-to-speech), used when config.voice has an entry for the bot']
];
for (const [name, what] of keys) say(`${findSecret(name) ? '✓' : '·'} ${name.padEnd(8)} ${what}${findSecret(name) ? '' : `  →  npm run secret -- set ${name}`}`);
say('Mail (旺财): see README → "旺财 (mail)"; it needs a Google OAuth client and `npm run mail:auth`.');
say('\nDone. Each bot sends you a hello in Batlink when the daemon first starts. 完成:每个机器人第一次上线时会在 Batlink 给你发一句招呼。');

// ---------- make them yours ----------
say('\n──── Make them yours / 让它们变成你的(可选,不改也能直接用) ────');
for (const a of config.agents ?? []) {
  const call = a.id === 'qingyue' ? '(translator — does not address you / 翻译,不称呼你)' : `calls you「${callNameFor(config, a.id)}」`;
  say(`  ${a.name} (${a.id}): ${call}, avatar ${a.avatar ?? '-'}`);
}
say('  Change in config.json, then restart (npm run install-service) / 在 config.json 里改,改完重启服务:');
say('    agents[].name / callName / avatar / hello   名字、怎么称呼你、头像、招呼');
say('    owner.callName                               所有助理统一用这个称呼(优先级低于 agents[].callName)');
say('    personas.lingxi.persona                      灵犀的性格(整段人设,自己写)');
say('    voice.<id>.voiceId                           语音回复用的声音(需要 minimax key)');
say('  Or just tell the AI that deployed this: "give 灵犀 a new name / personality / way to address me".');
say('  或者直接跟帮你部署的 AI 说:"给灵犀换个名字 / 性格 / 称呼"。');
rl?.close();
