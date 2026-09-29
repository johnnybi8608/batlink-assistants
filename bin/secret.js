#!/usr/bin/env node
// Manage API keys in the macOS Keychain (service "batlink-assistants"). See src/secrets.js.
//   npm run secret -- set <name>      prompts for the value (not echoed)
//   npm run secret -- check <name>    tells whether it is configured (never prints it)
//   npm run secret -- delete <name>
// Names used by the built-in features: xai, openai, minimax, mail-<account id> (written by mail:auth).

import { findSecret, setSecret, deleteSecret } from '../src/secrets.js';

const [cmd, name] = process.argv.slice(2);
if (!['set', 'check', 'delete'].includes(cmd) || !name) {
  console.error('usage: npm run secret -- set|check|delete <name>');
  process.exit(2);
}

function readHidden(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const input = process.stdin;
    let value = '';
    input.setRawMode?.(true);
    input.resume();
    input.setEncoding('utf8');
    input.on('data', function onData(chunk) {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          input.setRawMode?.(false);
          input.pause();
          input.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') process.exit(130);      // Ctrl-C
        if (ch === '\u007f') value = value.slice(0, -1); // Backspace
        else value += ch;
      }
    });
  });
}

if (cmd === 'check') {
  console.log(findSecret(name) ? `✓ ${name} is configured` : `· ${name} is not configured`);
} else if (cmd === 'delete') {
  console.log(deleteSecret(name) ? `✓ ${name} deleted` : `· ${name} was not in the Keychain`);
} else {
  const value = (await readHidden(`${name}: `)).trim();
  if (!value) { console.error('nothing entered; unchanged'); process.exit(1); }
  setSecret(name, value);
  console.log(`✓ ${name} saved to the Keychain (${value.length} characters)`);
}
