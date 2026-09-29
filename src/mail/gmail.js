// Gmail / Google Workspace mailbox access (Gmail API, OAuth).
//
// Authorisation: bin/mail-auth.js runs the browser consent flow once and stores the refresh token as the
//   secret "mail-<accountId>" (src/secrets.js). The token itself never appears in code or logs.
// Scopes: gmail.readonly (read) + gmail.compose (create and send drafts) + gmail.modify (only used to mark
//   pushed messages as read). Drafts are sent only by the mail watcher after the owner personally replies
//   "发送"; the AI side has no way to send mail.

import { readFileSync, existsSync, statSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { findSecret } from '../secrets.js';
import { mailRoot } from './store.js';

export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  // Only used to mark messages as read (remove the UNREAD label); cannot permanently delete or send mail
  'https://www.googleapis.com/auth/gmail.modify'
];
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Name of the secret holding the refresh token of a mailbox. */
export const tokenSecretName = (accountId) => `mail-${accountId}`;

/** Paths of the OAuth client file: per-mailbox first, then the shared one. */
export function clientPaths(accountId) {
  return { own: join(mailRoot(), accountId, 'client.json'), shared: join(mailRoot(), 'client.json') };
}

/**
 * The OAuth client file downloaded from Google Cloud ("Desktop app" type).
 * Uses <dataDir>/mail/<accountId>/client.json if present, otherwise the shared <dataDir>/mail/client.json
 * (an "External" client can authorise many Gmail accounts; a Workspace "Internal" one only accounts of
 * its own organisation). The file contains the client secret, so it is kept at mode 600.
 */
export function loadClient(accountId) {
  const { own, shared } = clientPaths(accountId);
  const path = existsSync(own) ? own : shared;
  if (!existsSync(path)) throw new Error(`Missing OAuth client file: ${shared} (or ${own}). Create a "Desktop app" OAuth client in Google Cloud and save the downloaded JSON there.`);
  try { if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600); } catch {}
  const json = JSON.parse(readFileSync(path, 'utf8'));
  const c = json.installed ?? json.web ?? json;
  if (!c.client_id || !c.client_secret) throw new Error(`OAuth client file has an unexpected format: ${path}`);
  return { clientId: c.client_id, clientSecret: c.client_secret };
}

export class GmailAccount {
  constructor(accountId) {
    this.id = accountId;
    this.accessToken = null;
    this.expiresAt = 0;
  }

  get authorized() {
    return Boolean(findSecret(tokenSecretName(this.id)));
  }

  async #token() {
    if (this.accessToken && Date.now() < this.expiresAt - 60_000) return this.accessToken;
    const refreshToken = findSecret(tokenSecretName(this.id));
    if (!refreshToken) throw new Error(`Mailbox ${this.id} is not authorised yet: run node bin/mail-auth.js --account ${this.id}`);
    const { clientId, clientSecret } = loadClient(this.id);
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      throw new Error(`Mailbox ${this.id}: token refresh failed (${res.status} ${body.error ?? ''}); it may need to be authorised again: node bin/mail-auth.js --account ${this.id}`);
    }
    this.accessToken = body.access_token;
    this.expiresAt = Date.now() + (body.expires_in ?? 3600) * 1000;
    return this.accessToken;
  }

  async api(path, { method = 'GET', query, body } = {}) {
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(k, item));
      else if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${await this.#token()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(`Gmail API ${method} ${path} → ${res.status} ${json.error?.message ?? ''}`);
      error.status = res.status;
      throw error;
    }
    return json;
  }

  profile() { return this.api('/profile'); }

  /** Ids of messages added to INBOX since startHistoryId (deduplicated, in order of appearance). */
  async newInboxMessageIds(startHistoryId) {
    const ids = [];
    let pageToken;
    let latest = startHistoryId;
    do {
      const page = await this.api('/history', {
        query: { startHistoryId, historyTypes: 'messageAdded', labelId: 'INBOX', pageToken, maxResults: 100 }
      });
      for (const h of page.history ?? []) {
        for (const added of h.messagesAdded ?? []) {
          const m = added.message;
          if (m?.id && (m.labelIds ?? []).includes('INBOX') && !ids.includes(m.id)) ids.push(m.id);
        }
      }
      if (page.historyId) latest = page.historyId;
      pageToken = page.nextPageToken;
    } while (pageToken);
    return { ids, historyId: latest };
  }

  getMessage(id) { return this.api(`/messages/${id}`, { query: { format: 'full' } }); }

  getThread(id) { return this.api(`/threads/${id}`, { query: { format: 'full' } }); }

  search(q, max = 10) { return this.api('/messages', { query: { q, maxResults: max } }); }

  getAttachment(messageId, attachmentId) { return this.api(`/messages/${messageId}/attachments/${attachmentId}`); }

  createDraft(raw, threadId) {
    return this.api('/drafts', { method: 'POST', body: { message: { raw, ...(threadId ? { threadId } : {}) } } });
  }

  getDraft(draftId) { return this.api(`/drafts/${draftId}`, { query: { format: 'full' } }); }

  /** Called only by the mail watcher after the owner approved the draft. */
  sendDraft(draftId) {
    return this.api('/drafts/send', { method: 'POST', body: { id: draftId } });
  }

  /** Mark as read (called after the message was pushed to the owner). */
  async markRead(messageId) {
    return this.api(`/messages/${messageId}/modify`, { method: 'POST', body: { removeLabelIds: ['UNREAD'] } });
  }
}
