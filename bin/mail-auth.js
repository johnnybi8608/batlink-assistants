#!/usr/bin/env node
// Authorise a mailbox (one-time): opens the browser to sign in to Google and click "Allow"; the refresh token
// is stored as the secret "mail-<account id>" (src/secrets.js, macOS Keychain by default).
// Prerequisite: a "Desktop app" OAuth client created in Google Cloud, with its downloaded JSON saved as
// <dataDir>/mail/client.json (shared by all mailboxes; a mailbox that needs its own client can use
// <dataDir>/mail/<account id>/client.json). The file is kept at mode 600.
//
// Usage: node bin/mail-auth.js --account <mailbox id, ASCII> [--label <name shown in pushes>]
//   e.g. node bin/mail-auth.js --account gmail --label 工作邮箱
// On success the mailbox is added to (or updated in) config.json → mail.accounts; the mail watcher starts
// pushing new mail within one poll interval (from this moment on, older mail is not pushed).

import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { SCOPES, loadClient, tokenSecretName, GmailAccount } from '../src/mail/gmail.js';
import { loadState, saveState, CONFIG_PATH, DEFAULT_MAIL_AGENT } from '../src/mail/store.js';
import { setSecret } from '../src/secrets.js';

const args = process.argv.slice(2);
const accountId = args[args.indexOf('--account') + 1];
const labelArg = args.includes('--label') ? args[args.indexOf('--label') + 1] : null;
if (!args.includes('--account') || !accountId || !/^[a-z0-9_-]+$/i.test(accountId)) {
  console.error('Usage: node bin/mail-auth.js --account <mailbox id: letters, digits, - or _> [--label <display name>]');
  process.exit(2);
}

let client;
try {
  client = loadClient(accountId);
} catch (error) {
  console.error(`✗ ${error.message}`);
  process.exit(1);
}

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash('sha256').update(verifier).digest());
const state = b64url(randomBytes(16));

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authUrl.search = new URLSearchParams({
  client_id: client.clientId,
  redirect_uri: redirectUri,
  response_type: 'code',
  scope: SCOPES.join(' '),
  access_type: 'offline',
  prompt: 'consent',
  code_challenge: challenge,
  code_challenge_method: 'S256',
  state
}).toString();

console.log('Opening the browser for authorisation… If it does not open, visit this link manually:');
console.log(authUrl.toString());
try { execFileSync('open', [authUrl.toString()]); } catch {}

const code = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Authorisation was not completed within 5 minutes')), 5 * 60 * 1000);
  server.on('request', (req, res) => {
    const url = new URL(req.url, redirectUri);
    if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
    const done = (ok, message) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<meta charset="utf-8"><body style="font-family:-apple-system,sans-serif;padding:40px"><h2>${ok ? '✅' : '❌'} ${message}</h2><p>You can close this page now.</p></body>`);
    };
    if (url.searchParams.get('state') !== state) { done(false, 'State check failed, please run the command again'); return; }
    if (url.searchParams.get('error')) { done(false, `Authorisation denied: ${url.searchParams.get('error')}`); clearTimeout(timer); reject(new Error('Authorisation denied')); return; }
    done(true, 'Authorised');
    clearTimeout(timer);
    resolve(url.searchParams.get('code'));
  });
}).finally(() => server.close());

const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri
  })
});
const token = await tokenRes.json().catch(() => ({}));
if (!tokenRes.ok || !token.refresh_token) {
  console.error(`✗ Token exchange failed (${tokenRes.status} ${token.error ?? ''} ${token.error_description ?? ''})`);
  process.exit(1);
}
setSecret(tokenSecretName(accountId), token.refresh_token);

const profile = await new GmailAccount(accountId).profile();
const st = loadState(accountId);
st.address = profile.emailAddress;
saveState(accountId, st);

// Add (or update) the mailbox in config.json → mail.accounts
const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
if (Array.isArray(config.mail)) config.mail = { accounts: config.mail };
config.mail ??= {};
config.mail.agent ??= DEFAULT_MAIL_AGENT;
config.mail.accounts ??= [];
const entry = config.mail.accounts.find((m) => m.id === accountId);
const label = labelArg ?? entry?.label ?? profile.emailAddress;
if (entry) Object.assign(entry, { provider: entry.provider ?? 'gmail', label, address: profile.emailAddress });
else config.mail.accounts.push({ id: accountId, provider: 'gmail', label, address: profile.emailAddress });
const tmp = `${CONFIG_PATH}.tmp`;
writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n');
renameSync(tmp, CONFIG_PATH);
console.log(`✓ "${label}" authorised: ${profile.emailAddress} (refresh token stored as secret "${tokenSecretName(accountId)}")`);
console.log('  The mail watcher will start pushing new mail within one poll interval.');
