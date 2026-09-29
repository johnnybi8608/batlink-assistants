// launchd service names and helpers (macOS). bin/install-service.js writes the plists.

import { execFileSync } from 'node:child_process';

export const LABEL_PREFIX = 'io.github.batlink-assistants';
export const LABELS = {
  daemon: `${LABEL_PREFIX}.daemon`,       // src/daemon.js: bot identities, Batlink connection, local HTTP API
  waker: `${LABEL_PREFIX}.waker`,         // bin/waker.js: wakes AI sessions on mentions / DMs
  mailwatch: `${LABEL_PREFIX}.mailwatch`  // bin/mailwatch.js: polls mailboxes for 旺财 (only when mail is configured)
};

/** Restarts a running service; returns false when it is not loaded. */
export function restartService(name) {
  try {
    execFileSync('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${LABELS[name]}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
