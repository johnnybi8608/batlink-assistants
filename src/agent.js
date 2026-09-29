// One AI bot identity on Batlink: log in, keep a WS open, receive direct and group messages, talk in groups.
//
// The order of inbound routing matters:
//   1. First check whether it is a group fan-out (plain JSON outer layer) -> group protocol
//   2. Otherwise decrypt it as a direct-message ECIES envelope
// Doing it the other way round breaks group messages: the direct-message open() fails on a group
// fan-out, and the message would then be acked (deleted) as garbage.

import { randomUUID } from 'node:crypto';
import { isSafeGroupId, pathInside } from './safe-id.js';
import { RealtimeConnection } from './batlink/realtime.js';
import { open, seal, erc20AddressFromPublicKey, verifyPayload } from './batlink/crypto.js';
import { decodeBase64Url } from './batlink/base64url.js';
import * as G from './group.js';
import { join, dirname } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
import { describeGroupText, describePrivateWire, compressImageForGroup, makeImageStorageText, makeImageRefStorageText, makeVoiceStorageText, parseMediaRefStorageText, DIRECT_IMAGE_MAX_BYTES } from './media.js';
import { uploadMedia, downloadMedia, confirmMediaReceived } from './batlink/media-transfer.js';
import { encodeBase64Url } from './batlink/base64url.js';

const recipientIsNotOwner = (agent) => !agent.ownerPubkey;

/**
 * "Send" command for the mail assistant: approves sending an email draft. Does not wake the AI;
 * the mail watcher executes it.
 * Accepts phrases like "发送", "发吧", "可以发", "确认发送", "发送 D3". The draft number comes from the
 * text itself, or from the quoted draft confirmation message.
 * @returns {{ draftNo: number|null } | null}
 */
function parseMailSendCommand(wire) {
  if (wire?.type !== 'text') return null;
  const text = String(wire.text ?? '').trim().replace(/[。.!！~～\s]+$/, '');
  const m = /^(?:确认)?\s*(?:发送|发出去|发出|发吧|发|可以发|可以发送|确认)\s*(?:[#＃]?\s*[Dd]\s*(\d+))?$/.exec(text);
  if (!m) return null;
  const quoted = /草稿\s*D(\d+)/.exec(String(wire.replyToPreviewText ?? ''));
  const no = m[1] ?? quoted?.[1] ?? null;
  return { draftNo: no ? Number(no) : null };
}

/**
 * Mail assistant: the owner saying "原文" (optionally with #number, or quoting a notification) asks for the
 * full text of that email. The mail watcher pushes it directly; the AI is not woken.
 */
function parseMailOriginalCommand(wire) {
  if (wire?.type !== 'text') return null;
  const text = String(wire.text ?? '').trim().replace(/[。.!！~～?？\s]+$/, '');
  const m = /^(?:给我|发我|发|看|看看|看下|看一下)?\s*(?:一下)?\s*原文\s*(?:吧|呢)?\s*(?:[#＃]\s*(\d+))?$/.exec(text);
  if (!m) return null;
  const quoted = /[#＃](\d+)/.exec(String(wire.replyToPreviewText ?? ''));
  const no = m[1] ?? quoted?.[1] ?? null;
  return { mailNo: no ? Number(no) : null };
}

const MESSAGE_TTL_SECONDS = 30 * 24 * 3600;
const TOKEN_RENEW_LEAD_SECONDS = 600;
const TOKEN_RENEW_JITTER_SECONDS = 300;

const MAX_SEEN_IDS = 50000;

export class Agent {
  /**
   * @param {{
   *   id: string, name: string, aliases?: string[],
   *   identity: object, client: import('./batlink/node-client.js').NodeClient,
   *   store: import('./store.js').AgentStore, ownerPubkey: string, logger: any,
   *   onGroupMessage: (event: object) => void
   * }} options
   */
  constructor({ id, name, aliases = [], avatar = null, identity, client, store, ownerPubkey, logger, onGroupMessage, mediaRoot = null, mailCommands = false, wakeOnImage = false, deviceId }) {
    this.id = id;
    this.deviceId = deviceId; // this bot's device id (one device per account; sent when signing in)
    this.mailCommands = mailCommands; // mail assistant: "send" in a direct message approves an email draft
    this.wakeOnImage = wakeOnImage; // translator: the image itself is the content, so a lone image also wakes it
    this.chatGroups = new Set(); // chat groups: a mention from anyone counts (owner, members, other bots); set by the daemon
    this.botPubkeys = new Set(); // public keys of all bots, to tell members apart from other AIs; set by the daemon
    this.mediaRoot = mediaRoot; // received/sent images and voice clips are stored in <mediaRoot>/<groupId>/
    this.name = name;
    this.avatar = avatar; // built-in app avatar id, e.g. avatar_boys_027 (the app ignores external URLs)
    this.identity = identity;
    this.client = client;
    this.store = store;
    this.ownerPubkey = ownerPubkey;
    this.logger = logger.child ? logger.child({ agent: id }) : logger;
    this.onGroupMessage = onGroupMessage;
    this.token = null;
    this.tokenExpiresAt = 0;
    this.tokenPromise = null;
    this.client.onUnauthorized?.((token) => this.invalidateToken(token));
    this.realtime = null;
    // Words that count as an @mention: display name + aliases, case-insensitive
    const names = [name, ...aliases].filter(Boolean).map((n) => n.toLowerCase());
    this.mentionNames = [...new Set(names)];
  }

  get pubkey() {
    return this.identity.publicKeyB64Url;
  }

  get address() {
    return this.identity.address;
  }

  get online() {
    return this.realtime?.connected === true;
  }

  /** Why the agent stopped reconnecting (session_replaced / logged_in_elsewhere / account_banned), else null */
  get offlineReason() {
    return this.realtime?.stopped ? (this.realtime.stoppedReason ?? 'stopped') : null;
  }

  /**
   * A usable token. Concurrent renewals share one login: separate logins would each push an
   * older token out of the node's per-account limit, and whoever held it would keep getting 401.
   */
  async ensureToken({ force = false } = {}) {
    // The realtime connection gave up because this account keeps signing in elsewhere: sending,
    // pulling the inbox etc. must not sign in again either, or two processes would keep fighting.
    if (this.realtime?.stoppedReason === 'logged_in_elsewhere') throw new Error('logged_in_elsewhere');
    const now = Math.floor(Date.now() / 1000);
    const lead = TOKEN_RENEW_LEAD_SECONDS + Math.floor(Math.random() * TOKEN_RENEW_JITTER_SECONDS);
    if (!force && this.token && this.tokenExpiresAt - lead > now) return this.token;
    if (!this.tokenPromise) {
      this.tokenPromise = (async () => {
        try {
          const { token, expiresAt } = await this.client.authenticate(this.identity, { deviceId: this.deviceId, login: true });
          this.token = token;
          const at = Math.floor(Date.now() / 1000);
          this.tokenExpiresAt = expiresAt > 1e12 ? Math.floor(expiresAt / 1000) : (expiresAt || at + 3600);
          return token;
        } finally {
          this.tokenPromise = null;
        }
      })();
    }
    return this.tokenPromise;
  }

  /** The node said this token is no longer valid (e.g. it restarted). Only dropped if it is still the current one. */
  invalidateToken(token) {
    if (token && this.token === token) {
      this.token = null;
      this.tokenExpiresAt = 0;
    }
  }

  /** Calls fn with a token; on 401 logs in again and retries once. fn returns {status} or throws an error ending in :401. */
  async #withToken(fn) {
    const token = await this.ensureToken();
    try {
      const result = await fn(token);
      if (result?.status !== 401) return result;
    } catch (error) {
      if (!/:401\b/.test(String(error?.message ?? error))) throw error;
    }
    this.invalidateToken(token);
    return fn(await this.ensureToken());
  }

  async start() {
    if (this.realtime) return;
    // Log in once first: this registers the address with the address service so the app can find/add it
    await this.ensureToken();
    this.realtime = new RealtimeConnection({
      baseUrl: this.client.baseUrl,
      label: `${this.id}:${this.pubkey.slice(0, 8)}`,
      logger: this.logger,
      getToken: async () => {
        const force = this.realtime?.tokenInvalid === true;
        if (this.realtime) this.realtime.tokenInvalid = false;
        return this.ensureToken({ force });
      },
      onInbox: async (envelope) => this.#handleEnvelope(envelope),
      onReady: async () => {
        const n = await this.catchUp().catch((error) => {
          this.logger.warn?.({ err: String(error) }, 'catch-up pull failed');
          return 0;
        });
        this.logger.info?.({ caughtUp: n }, 'WS connected');
      }
    });
    await this.realtime.start();
  }

  stop() {
    this.realtime?.stop();
    this.realtime = null;
  }

  /** Pull everything that queued up while offline, right after connecting */
  async catchUp() {
    const envelopes = await this.#withToken((token) => this.client.pullMessages(token));
    const handled = [];
    for (const envelope of envelopes) {
      if (await this.#handleEnvelope(envelope)) handled.push(envelope.messageId);
    }
    if (handled.length) await this.#withToken((token) => this.client.ackMessages(token, handled));
    return handled.length;
  }

  // ── Inbound verification ──
  // The bot does not rely on the relay node alone: every envelope is checked here exactly as a node checks it on
  // submission (signature over "messageId|recipient|createdAt|expiresAt|ciphertext" by the claimed sender, the
  // sender address derived from that key, not expired, not from the future), it must be addressed to this bot, and a
  // message id is processed only once (replays of an old, validly signed message are dropped).
  #seenIds = null;
  // Messages being processed right now: registered before the async work, so the same message arriving twice at
  // once (WebSocket push + catch-up pull) is handled only once
  #inFlight = new Set();

  #seenPath() { return join(dirname(this.store.path), 'seen-messages.json'); }

  #seen() {
    if (!this.#seenIds) {
      this.#seenIds = new Map();
      try { for (const [id, exp] of JSON.parse(readFileSync(this.#seenPath(), 'utf8'))) this.#seenIds.set(id, exp); } catch {}
    }
    return this.#seenIds;
  }

  #markSeen(envelope) {
    // Recorded in memory; written to disk at most every 3 seconds and capped in size. Rewriting the whole file
    // for every message (including refused ones from strangers) let anyone keep the disk busy.
    const seen = this.#seen();
    const now = Math.floor(Date.now() / 1000);
    seen.set(envelope.messageId, Number(envelope.expiresAt) || now + 2_592_000);
    this.#scheduleSeenFlush();
  }

  #seenFlushTimer = null;

  #scheduleSeenFlush() {
    if (this.#seenFlushTimer) return;
    this.#seenFlushTimer = setTimeout(() => { this.#seenFlushTimer = null; this.#flushSeen(); }, 3000);
    this.#seenFlushTimer.unref?.();
    if (!this.#seenExitHook) {
      this.#seenExitHook = true;
      process.once('exit', () => this.#flushSeen());
    }
  }

  #seenExitHook = false;

  #flushSeen() {
    const seen = this.#seen();
    const now = Math.floor(Date.now() / 1000);
    for (const [id, exp] of seen) if (exp < now) seen.delete(id);
    // Too many: drop the ones expiring soonest first (they stop being replayable first)
    if (seen.size > MAX_SEEN_IDS) {
      const drop = [...seen].sort((a, b) => a[1] - b[1]).slice(0, seen.size - MAX_SEEN_IDS);
      for (const [id] of drop) seen.delete(id);
    }
    try {
      const tmp = `${this.#seenPath()}.tmp`;
      writeFileSync(tmp, JSON.stringify([...seen]));
      renameSync(tmp, this.#seenPath());
    } catch {}
  }


  /** @returns {string|null} why the envelope is refused, or null when it is authentic and new */
  #rejectEnvelope(e) {
    if (!e.messageId || !e.senderPubkey || !e.senderSig) return 'missing_fields';
    const now = Math.floor(Date.now() / 1000);
    const createdAt = Number(e.createdAt);
    const expiresAt = Number(e.expiresAt);
    if (!(expiresAt > now)) return 'expired';
    if (!(createdAt > 0) || createdAt > now + 600) return 'bad_timestamp';
    if (e.senderAddress) {
      let derived = null;
      try { derived = erc20AddressFromPublicKey(decodeBase64Url(e.senderPubkey)); } catch {}
      if (!derived || derived.toLowerCase() !== String(e.senderAddress).toLowerCase()) return 'sender_address_mismatch';
    }
    // The signed recipient is this bot's key (as it is registered); the signature binds the message to us
    const recipients = [...new Set([this.identity.publicKeyB64Url, this.pubkey].filter(Boolean))];
    const signed = recipients.some((r) => verifyPayload([e.messageId, r, String(e.createdAt), String(e.expiresAt), e.ciphertext].join('|'), e.senderSig, e.senderPubkey));
    if (!signed) return 'invalid_signature';
    if (this.#seen().has(e.messageId) || this.#inFlight.has(e.messageId)) return 'replay';
    return null;
  }

  /** @returns {Promise<boolean>} true = safe to confirm (delete) */
  async #handleEnvelope(envelope) {
    if (!envelope?.ciphertext) return true;
    const refused = this.#rejectEnvelope(envelope);
    if (refused) {
      // Confirmed (removed from the inbox) but never processed
      if (refused !== 'replay') this.logger.warn?.({ messageId: envelope.messageId, from: envelope.senderPubkey?.slice(0, 10), reason: refused }, 'inbound message refused');
      return true;
    }
    this.#inFlight.add(envelope.messageId);
    try {
      const handled = await this.#processEnvelope(envelope);
      if (handled) this.#markSeen(envelope);
      return handled;
    } finally {
      this.#inFlight.delete(envelope.messageId); // on failure the message may be delivered and tried again
    }
  }

  async #processEnvelope(envelope) {

    const groupPayload = G.parseGroupFanout(envelope.ciphertext);
    if (groupPayload) {
      try {
        await this.#handleGroupPayload(groupPayload, envelope);
      } catch (error) {
        // A group image / voice that cannot be fetched right now: not acked, retried later
        if (error?.kind === 'transient') {
          this.logger.warn?.({ messageId: envelope.messageId, err: String(error) }, 'group image/voice download failed, will retry');
          return false;
        }
        this.logger.error?.({ err: String(error), groupId: groupPayload.groupId }, 'failed to handle group message');
      }
      return true;
    }

    // Direct messages: only the owner is accepted. They go into the dm stream (the waker uses it to wake
    // the personal assistant); anyone else's direct messages are only logged.
    // Envelopes that cannot be decrypted are acked too, so they do not clog the inbox.
    let plain;
    try {
      plain = open(envelope.ciphertext, this.identity.privateKey);
    } catch {
      this.logger.debug?.({ messageId: envelope.messageId }, 'cannot decrypt direct message envelope, skipping');
      return true;
    }
    if (envelope.senderPubkey !== this.ownerPubkey) {
      this.logger.info?.({ from: envelope.senderPubkey?.slice(0, 10) }, 'direct message from someone other than the owner (ignored)');
      return true;
    }
    let wire = null;
    try { wire = JSON.parse(plain); } catch { wire = { type: 'text', text: plain }; }
    // Image / voice in R2: download and decrypt first, then handle it like an inline one. If it cannot
    // be fetched right now, do not ack: the message is delivered again later.
    let mediaRef = null;
    if ((wire?.type === 'image' || wire?.type === 'voice') && wire.media && !wire.imageB64 && !wire.voiceB64) {
      try {
        const bytes = await downloadMedia(this.client, await this.ensureToken(), wire.media);
        wire = { ...wire, [wire.type === 'image' ? 'imageB64' : 'voiceB64']: encodeBase64Url(bytes) };
        mediaRef = wire.media;
      } catch (error) {
        if (error?.kind !== 'expired') {
          this.logger.warn?.({ messageId: envelope.messageId, err: String(error) }, 'image/voice download failed, will retry');
          return false;
        }
        wire = { ...wire, type: 'text', text: wire.type === 'image' ? '[图片已过期]' : '[语音已过期]' };
      }
    }
    const text = describePrivateWire(wire, { mediaDir: join(this.mediaRoot ?? '.', 'dm'), messageId: envelope.messageId });
    if (mediaRef) void this.ensureToken().then((token) => confirmMediaReceived(this.client, token, mediaRef)).catch(() => {});
    if (!text) return true;
    const command = this.mailCommands ? parseMailSendCommand(wire) : null;
    const original = this.mailCommands && !command ? parseMailOriginalCommand(wire) : null;
    this.onGroupMessage?.({
      agentId: this.id,
      groupId: 'dm',
      groupName: '私聊',
      senderRaw: envelope.senderPubkey,
      senderRole: 'owner',
      senderName: '我',
      text,
      // Send-approval commands do not wake the AI (mentioned=false); the mail watcher acts on `command`.
      // A lone image does not wake the AI: the owner usually follows up with a sentence, and the text then
      // wakes it together with the earlier images (seen all at once). Bots with wakeOnImage (translator) are the exception.
      mentioned: !command && !original && (this.wakeOnImage || wire?.type !== 'image'),
      ...(command ? { command: 'mail_send', draftNo: command.draftNo } : {}),
      ...(original ? { command: 'mail_original', mailNo: original.mailNo } : {}),
      clientMessageId: wire?.clientMessageId ?? envelope.messageId,
      at: Math.floor(Date.now() / 1000)
    });
    return true;
  }

  async #handleGroupPayload(payload, envelope) {
    const { groupId } = payload;
    // The group id comes from the message and ends up in file paths: drop anything the app would never generate
    if (!isSafeGroupId(groupId)) {
      this.logger.warn?.({ from: envelope.senderPubkey?.slice(0, 10) }, 'invalid group id, dropped');
      return;
    }
    const senderRaw = envelope.senderPubkey;

    // Any group message may carry the current group card; the key rotates after members are added/removed,
    // so the card attached to the message wins
    // A card is only accepted when the admin key's signature is valid, the sender is a member of it, it is for this
    // group, and — once we know the group — the admin key (= the group's join key) is the one we already have.
    // Otherwise a relay or a member could hand us a forged card (other members, another group key).
    let incomingRecord = payload.card && payload.cardSignature
      ? { card: payload.card, signature: payload.cardSignature }
      : null;
    if (incomingRecord) {
      const known = this.store.getCard(groupId);
      const why = incomingRecord.card.groupId !== groupId ? 'group_id_mismatch'
        : !G.verifyCardRecord(incomingRecord) ? 'invalid_card_signature'
        : !G.cardHasMember(incomingRecord.card, senderRaw) ? 'sender_not_in_card'
        : known && known.card.adminPublicKey !== incomingRecord.card.adminPublicKey ? 'admin_key_changed'
        : null;
      if (why) {
        this.logger.warn?.({ groupId, from: senderRaw?.slice(0, 10), reason: why }, 'group card refused');
        incomingRecord = null;
      }
    }
    if (incomingRecord) {
      const isMember = G.unboxGroupKey(incomingRecord.card, this.identity) !== null;
      const known = this.store.getCard(groupId);
      // Joining a group we do not know yet needs the owner: the message carrying the card must be signed by the
      // owner (that is what adding us from the owner's app sends). Being able to unbox the group key proves
      // nothing (anyone can make a group and box a key for us), and neither does the card's ownerRawPublicKey:
      // whoever makes the card writes that field and can simply put the owner's public key there. Without this a
      // stranger could pull us into their groups and fill every slot, keeping the owner's real groups out.
      const fromOwner = senderRaw === this.ownerPubkey;
      if (!known && !isMember) {
        this.logger.debug?.({ groupId }, 'card for an unknown group we are not in, ignored');
      } else if (!known && !fromOwner) {
        this.logger.warn?.({ groupId, from: senderRaw?.slice(0, 10) }, 'invited to a group by someone other than the owner, ignored');
      } else if (known && !isMember) {
      // Removed (a newer card without us): forget the group so its slot is free again
        if (Number(incomingRecord.card.epoch ?? 0) > Number(known.card?.epoch ?? 0)) {
          this.store.forget(groupId);
          this.logger.info?.({ groupId }, 'removed from a group, its slot is freed');
        }
      } else {
        const saved = this.store.saveCard(groupId, incomingRecord, { isMember });
        if (saved.joinedNow) {
          this.logger.info?.({ groupId, name: incomingRecord.card.name }, 'added to a group');
          // First thing after joining: announce our display name, otherwise members only see an address
          await this.announceProfile(groupId).catch((error) => {
            this.logger.warn?.({ err: String(error), groupId }, 'failed to set group display name');
          });
        }
      }
    }

    if (payload.type === 'group_member_profile_update' && payload.profile?.memberRawPublicKey === senderRaw) {
      // Only for a group we know, and only from a current member: otherwise anyone could invent group ids
      // and make us store (and rewrite the state file for) names in groups that do not exist.
      const known = this.store.getCard(groupId);
      if (known && G.cardHasMember(known.card, senderRaw)) {
        this.store.setMemberName(groupId, senderRaw, payload.profile.displayName);
      }
      return;
    }
    if (payload.type !== 'group_text') return;
    if (payload.reactionTargetId) return; // emoji reaction, not a message

    // Membership and the group key always come from the latest card stored here. A card that comes with
    // a message only updates the stored one to a newer version: a kicked member still holds the older
    // card (validly signed, with them on it), and judging by that one would let them keep talking.
    const record = this.store.getCard(groupId);
    // Only current members may post (checked against the verified card)
    if (record && !G.cardHasMember(record.card, senderRaw)) {
      this.logger.warn?.({ groupId, from: senderRaw?.slice(0, 10) }, 'group message from a non-member refused');
      return;
    }
    const groupKey = record ? G.unboxGroupKey(record.card, this.identity) : null;
    if (!groupKey) {
      this.logger.warn?.({ groupId }, 'no key for this group, cannot decrypt message');
      return;
    }
    let text;
    try {
      text = payload.ciphertext ? G.decryptWithGroupKey(payload.ciphertext, groupKey) : (payload.text ?? '');
    } catch (error) {
      this.logger.warn?.({ err: String(error), groupId }, 'failed to decrypt group message body');
      return;
    }
    if (!text.trim()) return;
    // Group image / voice in R2 (one copy for the group): download and decrypt it first, then
    // continue with the usual image / voice storage text
    const mediaRef = parseMediaRefStorageText(text);
    if (mediaRef) {
      try {
        const data = await this.#withToken((token) => downloadMedia(this.client, token, mediaRef.media));
        text = mediaRef.kind === 'voice'
          ? makeVoiceStorageText({ data, durationMs: mediaRef.durationMs ?? 0, waveform: mediaRef.waveform ?? null })
          : makeImageStorageText({ data, width: mediaRef.width ?? 0, height: mediaRef.height ?? 0, mime: mediaRef.mime ?? 'image/jpeg' });
      } catch (error) {
        if (error?.kind === 'transient') throw error; // not acked: it comes back on a later pull
        text = mediaRef.kind === 'voice' ? '[voice message no longer available]' : '[image no longer available]';
      }
    }
    // Image/voice "storage format" messages are saved to files; the stream only records a one-line summary
    // (so hundreds of KB of encoded data never end up in the AI context)
    const messageId = payload.clientMessageId ?? envelope.messageId;
    if (this.mediaRoot) text = describeGroupText(text, { mediaDir: pathInside(this.mediaRoot, groupId), messageId, senderRaw: envelope.senderPubkey });

    // Mention block: the list of mentioned members' public keys, encrypted with the group key in
    // mentionsCiphertext (the "@name" in the body is only for humans)
    let mentionKeys = [];
    if (payload.mentionsCiphertext) {
      try {
        const list = JSON.parse(G.decryptWithGroupKey(payload.mentionsCiphertext, groupKey));
        if (Array.isArray(list)) mentionKeys = list.map((m) => m?.k).filter(Boolean);
      } catch {
        // Bad data: treat as no mention block and fall back to text matching
      }
    }

    const ownText = text; // match "@my name" only against this message's own text, not the quoted content
    // Quoted reply: the summary of the quoted message {messageId, sender, previewType, previewText} is encrypted
    // with the group key in replyMetaCiphertext
    let repliedToMe = false;
    if (payload.replyMetaCiphertext) {
      try {
        const quote = JSON.parse(G.decryptWithGroupKey(payload.replyMetaCiphertext, groupKey));
        repliedToMe = quote?.sender === this.pubkey;
        const quotedName = quote?.sender === this.pubkey ? this.displayNameIn(groupId)
          : quote?.sender === this.ownerPubkey ? '主人'
          : this.store.memberName(groupId, quote?.sender, record.card) ?? '某人';
        if (quote?.previewText) text = `[引用 ${quotedName} 的消息: ${String(quote.previewText).slice(0, 300)}]\n${text}`;
      } catch {
        // cannot decrypt: treat as a normal message
      }
    }

    const role = senderRaw === this.pubkey ? 'self' : senderRaw === this.ownerPubkey ? 'owner' : 'other';
    const openGroup = this.chatGroups.has(groupId);
    // Being mentioned or being replied to both count as being called
    const mentionsMe = mentionKeys.includes(this.pubkey) || this.#mentionsMe(ownText, groupId) || repliedToMe;
    let senderAddress = null;
    try { senderAddress = erc20AddressFromPublicKey(decodeBase64Url(senderRaw)); } catch {}
    this.onGroupMessage?.({
      agentId: this.id,
      groupId,
      groupName: record.card.name,
      senderRaw,
      senderRole: role,
      senderName: this.store.memberName(groupId, senderRaw, record.card) ?? (role === 'owner' ? '我' : senderRaw.slice(0, 10)),
      text,
      // Regular project groups only react to the owner's mention; in chat groups anyone counts (except self)
      mentioned: openGroup ? role !== 'self' && mentionsMe : role === 'owner' && mentionsMe,
      mentionedBy: mentionKeys.includes(this.pubkey) ? 'block' : this.#mentionsMe(ownText, groupId) ? 'text' : repliedToMe ? 'reply' : null,
      ...(openGroup ? { openMention: true } : {}),
      fromBot: role !== 'self' && this.botPubkeys.has(senderRaw),
      senderAddress,
      clientMessageId: payload.clientMessageId ?? envelope.messageId,
      at: Math.floor(Date.now() / 1000)
    });
  }

  #mentionsMe(text, groupId) {
    const lower = text.toLowerCase();
    const nickname = groupId ? this.store.nickname(groupId)?.toLowerCase() : null;
    const names = nickname ? [...this.mentionNames, nickname] : this.mentionNames;
    return names.some((name) => lower.includes(`@${name}`));
  }

  /** The owner's @name in this group: the group nickname like the app uses, or the short address */
  #ownerMentionName(groupId, card) {
    const name = this.store.memberName(groupId, this.ownerPubkey, card);
    if (name && !/^0x[0-9a-f]{40}$/i.test(name)) return name;
    return G.shortAddress(erc20AddressFromPublicKey(decodeBase64Url(this.ownerPubkey)));
  }

  /**
   * Send an image to a group, compressed to the app's group image spec (long edge 1280, JPEG, <=160KB).
   * A copy of the sent image is kept in the media directory and the stream records "[图片] <path>".
   */
  async sendGroupImage(groupId, filePath) {
    const image = compressImageForGroup(filePath);
    let recordText = `[图片] ${filePath} (${image.width}×${image.height})`;
    if (this.mediaRoot) {
      const dir = pathInside(this.mediaRoot, groupId);
      mkdirSync(dir, { recursive: true });
      const copy = join(dir, `sent-${Date.now()}.jpg`);
      writeFileSync(copy, image.data);
      recordText = `[图片] ${copy} (${image.width}×${image.height})`;
    }
    // One copy in R2 for the whole group; inline only if the node has no media support
    const media = await this.#withToken((token) => uploadMedia(this.client, token, { data: image.data, kind: 'image', group: true }));
    const wireText = media
      ? makeImageRefStorageText({ media, width: image.width, height: image.height, mime: 'image/jpeg' })
      : makeImageStorageText(image);
    const result = await this.sendGroupText(groupId, wireText, { recordText });
    return { ...result, width: image.width, height: image.height, bytes: image.data.length };
  }

  /** Send a text to a group; with mentionOwner=true it starts with an @mention of the owner (highlighted in the app) */
  async sendGroupText(groupId, rawText, { mentionOwner = false, recordText = null } = {}) {
    const record = this.store.getCard(groupId);
    if (!record) throw new Error(`unknown_group:${groupId}`);
    const groupKey = G.unboxGroupKey(record.card, this.identity);
    if (!groupKey) throw new Error(`no_group_key:${groupId}`);
    const recipients = G.fanoutRecipients(record.card, this.pubkey);
    if (!recipients.length) throw new Error('group_has_no_other_members');

    let text = rawText;
    let mentions;
    if (mentionOwner && this.ownerPubkey) {
      const token = `@${this.#ownerMentionName(groupId, record.card)}`;
      text = `${token} ${rawText}`;
      mentions = [{ k: this.ownerPubkey, l: 0, n: token.length }];
    }
    const clientMessageId = randomUUID().toLowerCase();
    const payload = G.buildGroupTextPayload({ groupId, text, groupKeyRaw: groupKey, cardRecord: record, clientMessageId, mentions });
    const result = await this.#withToken((token) => this.client.groupFanout({
      token,
      identity: this.identity,
      groupId,
      recipients,
      ciphertext: G.encodeFanoutCiphertext(payload),
      notifyType: 'group_message'
    }));
    if (!result.ok) throw new Error(`group_send_failed:${result.status}:${result.errorCode ?? ''}`);

    // Record our own messages in the stream too, so other sessions / the next wake-up see the whole conversation
    this.onGroupMessage?.({
      agentId: this.id,
      groupId,
      groupName: record.card.name,
      senderRaw: this.pubkey,
      senderRole: 'self',
      senderName: this.displayNameIn(groupId),
      text: recordText ?? text,
      mentioned: false,
      clientMessageId,
      at: Math.floor(Date.now() / 1000)
    });
    return { clientMessageId, delivered: recipients.length };
  }

  /**
   * Group member list: name (group nickname, or the address), role (owner / bot / self / member), address.
   * Shown to the AI in chat groups so it knows who is in the group and who an "@someone" refers to.
   */
  groupMembers(groupId) {
    const record = this.store.getCard(groupId);
    if (!record) return [];
    return (record.card.memberPublicKeys ?? []).map((key) => {
      const raw = G.signRawOf(key);
      let address = null;
      try { address = erc20AddressFromPublicKey(decodeBase64Url(raw)); } catch {}
      const role = raw === this.pubkey ? 'self' : raw === this.ownerPubkey ? 'owner' : this.botPubkeys.has(raw) ? 'bot' : 'member';
      const name = raw === this.pubkey ? this.displayNameIn(groupId) : this.store.memberName(groupId, raw, record.card);
      return { name: name ?? address ?? raw.slice(0, 10), role, address };
    });
  }

  /** Display name in this group: the group nickname if set, otherwise the bot's default name */
  displayNameIn(groupId) {
    return this.store.nickname(groupId) ?? this.name;
  }

  /** Change the group nickname: store it and broadcast a profile update (also used after restarts) */
  async setGroupNickname(groupId, displayName) {
    const name = String(displayName ?? '').trim();
    if (!name) throw new Error('nickname_required');
    if (!this.store.getCard(groupId)) throw new Error(`unknown_group:${groupId}`);
    this.store.setNickname(groupId, name);
    await this.announceProfile(groupId);
  }

  /** Announce our display name and avatar in a group (silent, no push notification) */
  async announceProfile(groupId) {
    const record = this.store.getCard(groupId);
    if (!record) return;
    const displayName = this.displayNameIn(groupId);
    const payload = G.buildProfileUpdatePayload({
      groupId,
      memberRawPublicKey: this.pubkey,
      displayName,
      avatarId: this.avatar,
      cardRecord: record
    });
    const result = await this.#withToken((token) => this.client.groupFanout({
      token,
      identity: this.identity,
      groupId,
      recipients: G.fanoutRecipients(record.card, this.pubkey),
      ciphertext: G.encodeFanoutCiphertext(payload),
      notifyType: 'silent'
    }));
    if (!result.ok) throw new Error(`profile_update_failed:${result.status}`);
    this.store.setMemberName(groupId, this.pubkey, displayName);
    this.store.setAnnouncedAvatar(groupId, this.avatar);
    this.logger.info?.({ groupId, avatar: this.avatar }, `group display name set to ${displayName}`);
  }

  /**
   * Send a direct text message (to the owner). A bot has to message you once before it shows up in your
   * contacts and can be added to groups.
   * `source` matches what the app sends: client=BATLINKAPP + built-in avatar id (the app ignores displayName).
   * `origin` marks messages that did not come from the AI session itself (e.g. mail watcher notifications);
   * those are added to the personal assistant's context (its own words are not, the session remembers them).
   */
  async sendPrivateText(recipientPubkey, text, { origin = null } = {}) {
    const wire = JSON.stringify({
      v: 2,
      type: 'text',
      text,
      source: { client: 'BATLINKAPP', ...(this.avatar ? { headPhotoUrl: this.avatar } : {}) },
      senderEncPubkey: this.pubkey
    });
    const result = await this.#sendPrivateWire(recipientPubkey, wire);
    this.#recordPrivateSelf(text, origin);
    return result;
  }

  /** Send a direct image (compressed to the app's direct-message spec: long edge 1280, JPEG, <=320KB) */
  async sendPrivateImage(recipientPubkey, filePath, { origin = null } = {}) {
    if (!recipientPubkey) throw new Error(`${this.name} has no owner yet (ownerAddress not set), cannot send a direct message`);
    const image = compressImageForGroup(filePath, DIRECT_IMAGE_MAX_BYTES);
    // Through R2 when the node supports it, inline otherwise (older nodes)
    const media = await uploadMedia(this.client, await this.ensureToken(), { data: image.data, kind: 'image', recipientPubkey });
    const wire = JSON.stringify({
      v: 1,
      type: 'image',
      ...(media ? { media } : { imageB64: encodeBase64Url(image.data) }),
      imageMime: image.mime,
      imageWidth: image.width,
      imageHeight: image.height,
      imageBytes: image.data.length,
      source: { client: 'BATLINKAPP', ...(this.avatar ? { headPhotoUrl: this.avatar } : {}) },
      senderEncPubkey: this.pubkey
    });
    const result = await this.#sendPrivateWire(recipientPubkey, wire);
    this.#recordPrivateSelf(`[图片] ${filePath} (${image.width}×${image.height})`, origin);
    return { ...result, width: image.width, height: image.height, bytes: image.data.length };
  }

  /** Send a direct voice message (app voice format: AAC m4a + duration + 48-bar waveform); `text` is what it says, recorded in the stream */
  async sendPrivateVoice(recipientPubkey, { data, durationMs, waveform }, { text = '', origin = null } = {}) {
    if (!recipientPubkey) throw new Error(`${this.name} has no owner yet (ownerAddress not set), cannot send a direct message`);
    const media = await uploadMedia(this.client, await this.ensureToken(), { data, kind: 'voice', recipientPubkey });
    const wire = JSON.stringify({
      v: 1,
      type: 'voice',
      ...(media ? { media } : { voiceB64: encodeBase64Url(data) }),
      durationMs,
      voiceWaveform: waveform,
      source: { client: 'BATLINKAPP', ...(this.avatar ? { headPhotoUrl: this.avatar } : {}) },
      senderEncPubkey: this.pubkey
    });
    const result = await this.#sendPrivateWire(recipientPubkey, wire);
    this.#recordPrivateSelf(`[语音 ${Math.max(1, Math.round(durationMs / 1000))} 秒] ${text}`, origin);
    return { ...result, durationMs };
  }

  #recordPrivateSelf(text, origin) {
    if (recipientIsNotOwner(this)) return;
    this.onGroupMessage?.({
      agentId: this.id,
      groupId: 'dm',
      groupName: '私聊',
      senderRaw: this.pubkey,
      senderRole: 'self',
      senderName: this.name,
      text,
      mentioned: false,
      ...(origin ? { origin } : {}),
      clientMessageId: randomUUID().toLowerCase(),
      at: Math.floor(Date.now() / 1000)
    });
  }

  async #sendPrivateWire(recipientPubkey, wire) {
    // No owner yet (the agent's ownerAddress is still a placeholder): there is nobody to send to
    if (!recipientPubkey) throw new Error(`${this.name} has no owner yet (ownerAddress not set), cannot send a direct message`);
    const createdAt = Math.floor(Date.now() / 1000);
    const messageId = randomUUID().toLowerCase();
    const ciphertext = seal(wire, recipientPubkey);
    const result = await this.#withToken((token) => this.client.sendMessage({
      identity: this.identity,
      token,
      recipientPubkey,
      messageId,
      ciphertext,
      createdAt,
      expiresAt: createdAt + MESSAGE_TTL_SECONDS
    }));
    if (!result.ok) throw new Error(`private_send_failed:${result.status}:${result.errorCode ?? ''}`);
    return result;
  }
}
