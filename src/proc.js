// Shared helpers for spawning child processes (claude / codex / grok / node).

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Child environment without CLAUDE* / ANTHROPIC* variables. When this code is started from inside a
 * Claude Code session (e.g. when you run a setup script from Claude Code), those variables make the new `claude` think it
 * is a sub-process of that session, so it cannot find its own login or mixes up sessions.
 */
export function cleanEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CLAUDE|ANTHROPIC)/.test(key)));
}

/** Runs a child process and collects its output; optional stdin and timeout. */
export function run(cmd, args, { input, cwd, timeoutMs } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: cleanEnv() });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = timeoutMs ? setTimeout(() => child.kill('SIGTERM'), timeoutMs) : null;
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ code, signal, stdout, stderr });
    });
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ code: -1, signal: null, stdout, stderr: String(error) });
    });
    child.stdin.end(input ?? '');
  });
}

/** First existing path among the candidates, else the first one (so the error message names it). */
function firstExisting(...paths) {
  return paths.find((p) => p && existsSync(p)) ?? paths.find(Boolean);
}

// CLI locations. Override with CLAUDE_PATH / CODEX_PATH / GROK_PATH.
export const CLAUDE_BIN = process.env.CLAUDE_PATH ?? firstExisting('/opt/homebrew/bin/claude', '/usr/local/bin/claude', join(homedir(), '.local', 'bin', 'claude'));
export const CODEX_BIN = process.env.CODEX_PATH ?? firstExisting('/opt/homebrew/bin/codex', '/usr/local/bin/codex', '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex', '/Applications/ChatGPT.app/Contents/Resources/codex');
export const GROK_BIN = process.env.GROK_PATH ?? firstExisting(join(homedir(), '.grok', 'bin', 'grok'), '/opt/homebrew/bin/grok');

// Claude model and effort. Leave CLAUDE_MODEL empty to use the account default.
export const CLAUDE_MODEL_ARGS = [
  ...(process.env.CLAUDE_MODEL ? ['--model', process.env.CLAUDE_MODEL] : []),
  ...(process.env.CLAUDE_EFFORT ? ['--effort', process.env.CLAUDE_EFFORT] : [])
];
// Zero tools: no built-in tools and no MCP servers — the model can only produce text.
export const NO_TOOLS_ARGS = ['--tools', '', '--strict-mcp-config'];
