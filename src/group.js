// Batlink regular group protocol, field-for-field compatible with the mobile clients.
//
// Two layers (once this is clear, everything else follows):
//
//   Outer: group fan-out envelope. The sender uses the base64url of one "group payload JSON" as the
//          ciphertext and delivers a copy to every member (POST /v1/group/fanout). The outer layer is
//          NOT encrypted: relay nodes can see metadata such as the group card and member list, but not
//          the message body.
//   Inner: the body is encrypted separately with the group key (ChaCha20-Poly1305, the 32-byte raw key
//          is used directly, no KDF); the envelope {v:1, nonce, ct} is base64url'd and placed in the
//          payload's ciphertext field.
//
// Group key: 32 random bytes, used in its base64url STRING form. The group owner encrypts that string
// to each member with the same ECIES as direct messages and stores the boxes in the card's
// groupKeyBoxes (indexed by member key).
// The owner rotates the key on EVERY membership change (epoch+1), so always decrypt with the card
// attached to the message itself, not a cached older card; otherwise the first message after someone
// is added cannot be decrypted.
//
// Bots are never group owners and never need to sign cards: when sending, the received card is passed
// back unchanged, and the app re-canonicalizes and verifies it itself, so there is no need to replicate
// the Swift JSONEncoder byte format here.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { open } from './batlink/crypto.js';
import { decodeBase64Url, encodeBase64Url } from './batlink/base64url.js';
import { ed25519 } from '@noble/curves/ed25519';

// ── Group card verification ──────────────────────────────────────────────
// A group card is signed (Ed25519) by the group's admin key, card.adminPublicKey — which is also the group's join key.
// The signed bytes are the card as the iOS client encodes it: only these fields, keys sorted, absent optionals omitted,
// no slash escaping. Unknown extra fields are ignored by the other clients, so they are not part of the signature either.
const CARD_FIELDS = ['groupId', 'name', 'remark', 'avatarId', 'ownerRawPublicKey', 'adminPublicKey', 'memberPublicKeys', 'groupKeyBoxes', 'members', 'epoch', 'updatedAt'];
const MEMBER_FIELDS = ['memberRawPublicKey', 'displayName', 'avatarId', 'updatedAt'];
const sorted = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
const pick = (o, fields) => Object.fromEntries(fields.filter((k) => o?.[k] !== undefined && o?.[k] !== null).map((k) => [k, o[k]]));

export function canonicalCardJson(card) {
  const c = pick(card, CARD_FIELDS);
  if (c.groupKeyBoxes) c.groupKeyBoxes = sorted(c.groupKeyBoxes);
  if (Array.isArray(c.members)) c.members = c.members.map((m) => sorted(pick(m, MEMBER_FIELDS)));
  return JSON.stringify(sorted(c));
}

/** true when record.signature is the admin key's valid signature over the card */
export function verifyCardRecord(record) {
  try {
    const sig = decodeBase64Url(String(record?.signature ?? ''));
    const pub = decodeBase64Url(String(record?.card?.adminPublicKey ?? ''));
    if (!sig || sig.length !== 64 || !pub || pub.length !== 32) return false;
    return ed25519.verify(sig, Buffer.from(canonicalCardJson(record.card), 'utf8'), pub);
  } catch {
    return false;
  }
}

/** Is this raw public key one of the card's members? */
export function cardHasMember(card, rawKey) {
  return (card?.memberPublicKeys ?? []).some((k) => signRawOf(k) === rawKey);
}

/** The four group payload types the app accepts */
export const GROUP_PAYLOAD_TYPES = new Set([
  'group_text',
  'group_member_profile_update',
  'group_card_update',
  'group_system_invite'
]);

/**
 * Check whether an inbox envelope is a group fan-out; if so, return the parsed payload.
 *
 * Must be called BEFORE direct-message ECIES decryption: the fan-out outer layer is plain JSON
 * ({"v":1,...}), so the direct-message open() always fails on it, and the group message would then be
 * acked (deleted) as garbage.
 * @returns {object|null}
 */
export function parseGroupFanout(envelopeCiphertext) {
  const raw = decodeBase64Url(envelopeCiphertext);
  if (!raw || raw[0] !== 0x7b /* '{' */) return null;
  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload.groupId !== 'string') return null;
  return GROUP_PAYLOAD_TYPES.has(payload.type) ? payload : null;
}

/**
 * Member key -> signing public key (raw base64url), same rules as the app:
 * 32/33/65 bytes is the key itself; 64/66/130 bytes is "signing key + encryption key" concatenated,
 * take the first half.
 * @returns {string|null}
 */
export function signRawOf(memberKey) {
  const raw = decodeBase64Url(String(memberKey ?? '').trim());
  if (!raw) return null;
  switch (raw.length) {
    case 32:
    case 33:
    case 65:
      return encodeBase64Url(raw);
    case 64:
      return encodeBase64Url(raw.subarray(0, 32));
    case 66:
      return encodeBase64Url(raw.subarray(0, 33));
    case 130:
      return encodeBase64Url(raw.subarray(0, 65));
    default:
      return null;
  }
}

/**
 * Extract our own group key box from the card.
 * Boxes may be indexed by the member's canonical key or by its signRaw, so try both.
 * @returns {string|null} the group key as a base64url string
 */
export function unboxGroupKey(card, identity) {
  const boxes = card?.groupKeyBoxes;
  if (!boxes || typeof boxes !== 'object') return null;
  const selfRaw = identity.publicKeyB64Url;

  let boxed = boxes[selfRaw];
  if (!boxed) {
    for (const [key, value] of Object.entries(boxes)) {
      if (signRawOf(key) === selfRaw) {
        boxed = value;
        break;
      }
    }
  }
  if (!boxed) return null;
  try {
    const groupKey = open(boxed, identity.privateKey).trim();
    return decodeBase64Url(groupKey)?.length === 32 ? groupKey : null;
  } catch {
    return null;
  }
}

/** Group key -> 32-byte Buffer */
function keyBytes(groupKeyRaw) {
  const key = decodeBase64Url(groupKeyRaw);
  if (!key || key.length !== 32) throw new Error('invalid_group_key');
  return key;
}

/** Decrypt a message body with the group key */
export function decryptWithGroupKey(ciphertext, groupKeyRaw) {
  const envelope = JSON.parse(decodeBase64Url(ciphertext).toString('utf8'));
  if (envelope?.v !== 1) throw new Error('unsupported_group_envelope');
  const nonce = decodeBase64Url(envelope.nonce);
  const sealed = decodeBase64Url(envelope.ct);
  if (!nonce || nonce.length !== 12 || !sealed || sealed.length < 16) {
    throw new Error('malformed_group_ciphertext');
  }
  const decipher = createDecipheriv('chacha20-poly1305', keyBytes(groupKeyRaw), nonce, { authTagLength: 16 });
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  return plain.toString('utf8');
}

/** Encrypt a message body with the group key */
export function encryptWithGroupKey(plainText, groupKeyRaw) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('chacha20-poly1305', keyBytes(groupKeyRaw), nonce, { authTagLength: 16 });
  const body = Buffer.concat([cipher.update(Buffer.from(plainText, 'utf8')), cipher.final()]);
  const envelope = {
    v: 1,
    nonce: encodeBase64Url(nonce),
    ct: encodeBase64Url(Buffer.concat([body, cipher.getAuthTag()]))
  };
  return encodeBase64Url(Buffer.from(JSON.stringify(envelope), 'utf8'));
}

/**
 * Fan-out recipients: every member in the card except ourselves (signing public keys).
 * @returns {string[]}
 */
export function fanoutRecipients(card, selfRaw) {
  const seen = new Set();
  for (const key of card?.memberPublicKeys ?? []) {
    const raw = signRawOf(key);
    if (raw && raw !== selfRaw) seen.add(raw);
  }
  return [...seen];
}

/** Payload -> outer ciphertext (just the base64url of the plain JSON) */
export function encodeFanoutCiphertext(payload) {
  return encodeBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'));
}

/**
 * Group text message payload.
 * The card and its signature are attached unchanged: new members get the latest key from it.
 */
export function buildGroupTextPayload({ groupId, text, groupKeyRaw, cardRecord, clientMessageId, mentions }) {
  const payload = {
    v: 1,
    type: 'group_text',
    groupId,
    ciphertext: encryptWithGroupKey(text, groupKeyRaw),
    sentAt: Math.floor(Date.now() / 1000)
  };
  // Mentions: [{k: public key, l: start, n: length}], positions in UTF-16 units (JS string length is UTF-16,
  // which matches the app's NSRange)
  if (mentions?.length) payload.mentionsCiphertext = encryptWithGroupKey(JSON.stringify(mentions), groupKeyRaw);
  if (cardRecord) {
    payload.card = cardRecord.card;
    payload.cardSignature = cardRecord.signature;
  }
  if (clientMessageId) payload.clientMessageId = clientMessageId;
  return payload;
}

/**
 * Group member profile update (change our own display name in the group).
 * The app only accepts updates for the sender itself: profile.memberRawPublicKey must equal the sender key.
 */
export function buildProfileUpdatePayload({ groupId, memberRawPublicKey, displayName, avatarId, cardRecord }) {
  const payload = {
    v: 1,
    type: 'group_member_profile_update',
    groupId,
    sentAt: Math.floor(Date.now() / 1000),
    profile: {
      memberRawPublicKey,
      displayName,
      updatedAt: Math.floor(Date.now() / 1000)
    }
  };
  if (avatarId) payload.profile.avatarId = avatarId;
  if (cardRecord) {
    payload.card = cardRecord.card;
    payload.cardSignature = cardRecord.signature;
  }
  return payload;
}

/** Same short form the app uses: 0x1234567...abcdefg */
export function shortAddress(address) {
  const a = String(address ?? '').trim();
  return a.length > 17 ? `${a.slice(0, 7)}...${a.slice(-7)}` : a;
}
