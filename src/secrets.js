// Secrets (API keys, OAuth tokens). Never stored in the repo or in config.json.
//
// Lookup order for a secret called <name> (e.g. "xai", "openai", "minimax", "mail-gmail"):
//   1. environment variable BATLINK_SECRET_<NAME>  (upper-case, "-" → "_"), e.g. BATLINK_SECRET_XAI
//   2. macOS Keychain: service "batlink-assistants", account <name>
//
// Store one with:  npm run secret -- set <name>   (prompts without echo, writes to the Keychain)

import { execFileSync } from 'node:child_process';

export const KEYCHAIN_SERVICE = 'batlink-assistants';

const envName = (name) => `BATLINK_SECRET_${String(name).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

/** Returns the secret or null when it is not configured. */
export function findSecret(name) {
  const fromEnv = process.env[envName(name)];
  if (fromEnv) return fromEnv.trim();
  try {
    return execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', name, '-w'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
    }).trim() || null;
  } catch {
    return null;
  }
}

/** Returns the secret or throws an error that tells the user how to add it. */
export function getSecret(name) {
  const value = findSecret(name);
  if (!value) {
    throw new Error(`Missing secret "${name}". Store it with: npm run secret -- set ${name}  (or set ${envName(name)})`);
  }
  return value;
}

/** Writes (or replaces) a secret in the macOS Keychain. */
export function setSecret(name, value) {
  // Through `security -i` (commands on stdin) so the value never appears in the process list
  const q = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  if (/[\r\n]/.test(value)) throw new Error('a secret cannot contain line breaks');
  execFileSync('security', ['-i'], { input: `add-generic-password -U -s ${q(KEYCHAIN_SERVICE)} -a ${q(name)} -w ${q(value)}\n`, stdio: ['pipe', 'ignore', 'ignore'] });
}

export function deleteSecret(name) {
  try {
    execFileSync('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
