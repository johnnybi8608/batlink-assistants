// Realtime connection for one identity, using the same channel as the app:
//   ws(s)://<node>/v1/ws?token=<session token>
//
// Frame protocol (same as the mobile clients):
//   recv server.hello         connection ready
//   recv server.ping          -> must answer client.pong, otherwise the node drops the socket after 60s
//   recv server.inbox.new     new message (encrypted envelope)
//   send client.inbox.confirm ack. Confirming DELETES the message on the node, so only confirm after
//                             processing succeeded; on failure leave it, and it is delivered again after
//                             reconnecting (at-least-once delivery).
//
// The node does NOT replay the backlog when a socket connects (it only registers the connection),
// so every (re)connect first pulls the inbox to catch up, and relies on pushes after that.

import WebSocket from 'ws';

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60000;
// Reconnecting after a 4002 kick: wait 10 s after the first, 60 s after the second; stop on the
// KICK_STOP_AFTER-th within KICK_WINDOW_MS.
const KICK_DELAYS_MS = [10_000, 60_000];
const KICK_WINDOW_MS = 10 * 60 * 1000;
const KICK_STOP_AFTER = 3;

export class RealtimeConnection {
  /**
   * @param {{
   *   baseUrl: string,
   *   label: string,
   *   logger: any,
   *   getToken: () => Promise<string>,     // called when a token is needed (may trigger a re-login)
   *   onInbox: (envelope: object) => Promise<boolean>,  // return true to confirm (delete) the message
   *   onReady?: () => Promise<void>        // catch-up hook, run after every connect
   * }} options
   */
  constructor({ baseUrl, label, logger, getToken, onInbox, onReady }) {
    this.baseUrl = baseUrl;
    this.label = label;
    this.logger = logger;
    this.getToken = getToken;
    this.onInbox = onInbox;
    this.onReady = onReady;
    this.ws = null;
    this.stopped = false;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.connected = false;
  }

  #wsUrl(token) {
    const base = this.baseUrl.replace(/^http/, 'ws').replace(/\/+$/, '');
    return `${base}/v1/ws?token=${encodeURIComponent(token)}`;
  }

  async start() {
    this.stopped = false;
    await this.#connect();
  }

  async #connect() {
    if (this.stopped) return;
    let token;
    try {
      token = await this.getToken();
    } catch (error) {
      this.logger.warn?.({ err: String(error), label: this.label }, 'failed to get token, will reconnect later');
      this.#scheduleReconnect();
      return;
    }

    const ws = new WebSocket(this.#wsUrl(token), { handshakeTimeout: 15000 });
    this.ws = ws;

    ws.on('open', async () => {
      this.connected = true;
      this.reconnectAttempts = 0;
      this.logger.debug?.({ label: this.label }, 'WS connected');
      // Catch up first: messages that arrived while offline are not pushed, only pullable
      try {
        await this.onReady?.();
      } catch (error) {
        this.logger.warn?.({ err: String(error), label: this.label }, 'catch-up pull failed');
      }
    });

    ws.on('message', (raw) => {
      this.#handleFrame(raw).catch((error) => {
        this.logger.warn?.({ err: String(error), label: this.label }, 'failed to handle WS frame');
      });
    });

    ws.on('close', (code) => {
      // Closing of an older socket (already replaced) does not matter: "replaced by a new
      // connection" is exactly what our own new socket caused.
      if (ws !== this.ws) return;
      this.connected = false;
      // 4001 = the same identity connected elsewhere (two programs with one identity); 4003 = banned.
      // Neither reconnects on its own, or two instances would keep kicking each other.
      if (code === 4001 || code === 4003) {
        this.logger.error?.({ label: this.label, code }, code === 4001 ? 'this identity connected elsewhere; this connection was replaced, not reconnecting' : 'account banned, not reconnecting');
        this.stopped = true;
        this.stoppedReason = code === 4001 ? 'session_replaced' : 'account_banned'; // shown in /status
        return;
      }
      // 4002 = the account signed in on another device. A bot's account is the bot's only: sign in
      // again to take it back (the other device is logged out). But two processes on one identity
      // (e.g. the seed copied to another machine) would fight forever: wait 10 s after the first kick,
      // 60 s after the second, and stop on the third within 10 minutes (/status shows
      // logged_in_elsewhere) instead of burning the login rate limit.
      if (code === 4002) {
        const now = Date.now();
        this.kickTimes = [...(this.kickTimes ?? []).filter((t) => now - t < KICK_WINDOW_MS), now];
        if (this.kickTimes.length >= KICK_STOP_AFTER) {
          this.logger.error?.({ label: this.label, kicks: this.kickTimes.length }, 'this account keeps signing in elsewhere (two processes?), not reconnecting');
          this.stopped = true;
          this.stoppedReason = 'logged_in_elsewhere'; // shown in /status
          return;
        }
        this.logger.warn?.({ label: this.label }, 'this account signed in on another device; signing in again shortly to take it back');
        this.tokenInvalid = true;
        this.#scheduleReconnect(KICK_DELAYS_MS[this.kickTimes.length - 1]);
        return;
      }
      // 1008 = policy violation, which the node uses for an invalid token -> log in again on reconnect
      if (code === 1008) {
        this.logger.info?.({ label: this.label }, 'token invalid, will log in again when reconnecting');
        this.tokenInvalid = true;
      }
      this.#scheduleReconnect();
    });

    ws.on('error', (error) => {
      this.logger.debug?.({ err: String(error), label: this.label }, 'WS error');
    });
  }

  async #handleFrame(raw) {
    let frame;
    try {
      frame = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    switch (frame.type) {
      case 'server.ping':
        this.#send({ type: 'client.pong' });
        return;
      case 'server.hello':
      case 'server.pong':
        return;
      case 'server.inbox.new': {
        const handled = await this.onInbox({
          messageId: frame.message_id ?? frame.messageId,
          senderPubkey: frame.sender_pubkey ?? frame.senderPubkey,
          senderAddress: frame.sender_address ?? frame.senderAddress,
          senderSig: frame.sender_sig ?? frame.senderSig,
          createdAt: frame.created_at ?? frame.createdAt,
          expiresAt: frame.expires_at ?? frame.expiresAt,
          ciphertext: frame.ciphertext
        });
        // Confirm only on success: confirming deletes it on the node; on failure keep it for the next reconnect
        if (handled) {
          this.#send({ type: 'client.inbox.confirm', message_id: frame.message_id ?? frame.messageId });
        }
        return;
      }
      default:
        return;
    }
  }

  #send(payload) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  #scheduleReconnect(minDelayMs = 0) {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    const backoff = Math.min(RECONNECT_BASE_MS * 2 ** (this.reconnectAttempts - 1), RECONNECT_MAX_MS);
    // Jitter: when many identities drop at once, avoid all of them hammering the node at the same moment
    const delay = Math.max(minDelayMs, backoff / 2 + Math.random() * (backoff / 2));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.#connect().catch((error) => {
        this.logger.warn?.({ err: String(error), label: this.label }, 'reconnect failed');
        this.#scheduleReconnect();
      });
    }, delay);
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.ws?.close();
    } catch {
      // shutting down, ignore
    }
    this.ws = null;
    this.connected = false;
  }
}
