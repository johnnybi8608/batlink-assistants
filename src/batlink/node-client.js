// Batlink node HTTP client. Routes and field names follow the node's HTTP API.
//
//  POST /v1/auth/challenge  → { challenge, expiresAt }
//  POST /v1/auth/verify     → { token, expiresAt }        establishes presence (required for outbound)
//  POST /v1/message/send    → 202/404/503                 requires the sender's Bearer token, plus the signature
//  POST /v1/message/pull    → { messages: [...] }          requires Bearer token
//  POST /v1/message/ack/batch                              requires Bearer token
//
// Signature scheme (as verified by the node):
//   sender_sig = base64url( ECDSA_secp256k1( SHA256("msgId|recipient|createdAt|expiresAt|ciphertext") ) )

import { randomUUID } from 'node:crypto';
import { signPayload } from './crypto.js';

const DEFAULT_TIMEOUT_MS = 15000;

export class NodeClient {
  /**
   * @param {{baseUrl: string, timeoutMs?: number, logger?: any}} options
   */
  constructor({ baseUrl, timeoutMs = DEFAULT_TIMEOUT_MS, logger = console }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    /** Told about every 401: each agent checks whether it is its current token and drops it if so. */
    this.unauthorizedListeners = new Set();
  }

  onUnauthorized(fn) {
    this.unauthorizedListeners.add(fn);
  }

  async #request(path, { method = 'POST', body, token } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
      if (token && response.status === 401) {
        for (const fn of this.unauthorizedListeners) fn(token);
      }
      const text = await response.text();
      let json = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      return { status: response.status, ok: response.ok, json, text };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Open a session: challenge -> sign -> verify. Returns { token, expiresAt }.
   * One device per account: deviceId is this bot's own device id (kept in its data folder, stable
   * across restarts). A bot's account is used by the bot only, so every sign-in counts as a real one
   * (login=true): if someone signs in to the bot's account elsewhere, the bot takes it back on its
   * next reconnect. The signed message is "batlink-node-login-v1\n" + challenge + "\n" + deviceId +
   * "\n" + "login" (the prefix keeps sign-in signatures apart from anything else the key signs).
   */
  async authenticate(identity, { deviceId, login = true } = {}) {
    if (!deviceId) throw new Error('auth_device_id_missing');
    const challengeRes = await this.#request('/v1/auth/challenge', { body: {} });
    if (!challengeRes.ok || !challengeRes.json?.challenge) {
      throw new Error(`auth_challenge_failed:${challengeRes.status}`);
    }
    const challenge = challengeRes.json.challenge;
    const signature = signPayload(`batlink-node-login-v1\n${challenge}\n${deviceId}\n${login ? 'login' : 'resume'}`, identity.privateKey);

    const verifyRes = await this.#request('/v1/auth/verify', {
      body: {
        pubkey: identity.publicKeyB64Url,
        signature,
        challenge,
        erc20Address: identity.address,
        deviceId,
        login
      }
    });
    if (!verifyRes.ok || !verifyRes.json?.token) {
      throw new Error(`auth_verify_failed:${verifyRes.status}:${verifyRes.text?.slice(0, 200)}`);
    }
    return { token: verifyRes.json.token, expiresAt: verifyRes.json.expiresAt ?? 0 };
  }

  /**
   * Send one already-encrypted message. Needs the sender's token, and a valid signature.
   * @returns {{ok: boolean, status: number, errorCode?: string}}
   */
  async sendMessage({
    identity,
    token,
    recipientPubkey,
    messageId,
    ciphertext,
    createdAt,
    expiresAt,
    notifyType = 'message_delivered'
  }) {
    const signingPayload = [messageId, recipientPubkey, String(createdAt), String(expiresAt), ciphertext].join('|');
    const senderSig = signPayload(signingPayload, identity.privateKey);

    const res = await this.#request('/v1/message/send', {
      token,
      body: {
        recipient_pubkey: recipientPubkey,
        message_id: messageId,
        created_at: createdAt,
        expires_at: expiresAt,
        ciphertext,
        sender_pubkey: identity.publicKeyB64Url,
        sender_address: identity.address,
        sender_sig: senderSig,
        notify_type: notifyType
      }
    });

    if (res.ok) return { ok: true, status: res.status };
    return {
      ok: false,
      status: res.status,
      errorCode: res.json?.code ?? res.json?.error_code ?? res.json?.message ?? res.text?.slice(0, 200)
    };
  }

  /** Pull the inbox. Returns an array of envelopes (camelCase fields). */
  async pullMessages(token) {
    const res = await this.#request('/v1/message/pull', { body: {}, token });
    if (!res.ok) throw new Error(`pull_failed:${res.status}`);
    return Array.isArray(res.json?.messages) ? res.json.messages : [];
  }

  /** Batch ack. The node deletes acked messages, so call this only after local processing is done. */
  async ackMessages(token, messageIds) {
    if (!messageIds.length) return;
    const res = await this.#request('/v1/message/ack/batch', {
      body: { message_ids: messageIds },
      token
    });
    if (!res.ok) throw new Error(`ack_failed:${res.status}`);
  }

  /**
   * Address -> public key, the same lookup the app does.
   * Requires a token; returns {address, userPubkey, publicKey}. Prefer publicKey, fall back to userPubkey.
   * Callers MUST verify that the returned key derives the queried address; never trust the directory blindly.
   * @returns {Promise<{address: string, userPubkey: string, publicKey?: string} | null>} null when not found
   */
  async resolveAddress(address, token) {
    const encoded = encodeURIComponent(address);
    const res = await this.#request(`/v1/user/resolve-address?address=${encoded}`, {
      method: 'GET',
      token
    });
    if (res.status === 404) return null;
    if (!res.ok || !res.json) throw new Error(`resolve_address_failed:${res.status}`);
    return res.json;
  }

  /**
   * Group message fan-out (same as the mobile clients).
   * All members share one ciphertext (the outer layer is the base64url of the group payload JSON and is
   * NOT encrypted; confidentiality comes from the body inside, which is encrypted with the group key).
   * Each member gets its own message_id and signature, using exactly the same scheme as direct messages.
   * Requires a Bearer token.
   * @param {{token: string, identity: object, groupId: string, recipients: string[],
   *          ciphertext: string, notifyType?: string}} params
   */
  async groupFanout({ token, identity, groupId, recipients, ciphertext, notifyType = 'group_message' }) {
    const createdAt = Math.floor(Date.now() / 1000);
    const expiresAt = createdAt + 2_592_000;
    const items = recipients.map((recipientPubkey) => {
      const messageId = randomUUID();
      const signingPayload = [messageId, recipientPubkey, String(createdAt), String(expiresAt), ciphertext].join('|');
      return {
        recipient_pubkey: recipientPubkey,
        message_id: messageId,
        sender_sig: signPayload(signingPayload, identity.privateKey)
      };
    });
    const post = (list) => this.#request('/v1/group/fanout', {
      token,
      body: {
        group_id: groupId,
        created_at: createdAt,
        expires_at: expiresAt,
        ciphertext,
        sender_pubkey: identity.publicKeyB64Url,
        sender_address: identity.address,
        notify_type: notifyType,
        items: list
      }
    });
    const res = await post(items);
    if (res.ok) {
      // The node lists members whose copy was not accepted (full inbox, a node briefly down).
      // Resend exactly those in the background, same message ids and signatures, up to 3 times
      // (after 2, 10 and 30 s), each time only who is still missing; copies already stored come
      // back as duplicates, so nobody gets it twice. The send itself does not wait for this.
      const failedOf = (r) => new Set(Array.isArray(r?.json?.failed) ? r.json.failed : []);
      let remaining = failedOf(res);
      if (remaining.size > 0) {
        (async () => {
          for (const delay of [2000, 10000, 30000]) {
            await new Promise((r) => setTimeout(r, delay));
            const retry = await post(items.filter((it) => remaining.has(it.recipient_pubkey))).catch(() => null);
            if (retry?.ok) {
              remaining = failedOf(retry);
              if (remaining.size === 0) return;
            }
          }
          console.warn(`[groupFanout] ${remaining.size} member(s) still not reached after retries, group=${groupId}`);
        })();
      }
      return { ok: true, status: res.status };
    }
    return {
      ok: false,
      status: res.status,
      errorCode: res.json?.code ?? res.json?.error_code ?? res.json?.message ?? res.text?.slice(0, 200)
    };
  }

  /** /v1/media/* calls (Bearer token), returned as { status, ok, json } */
  async mediaCall(path, body, token) {
    return this.#request(path, { body, token });
  }

  async health() {
    const res = await this.#request('/v1/health', { method: 'GET' });
    return res.ok;
  }
}
