// Batlink end-to-end encryption and signatures (Node implementation).
//
// Must be byte-for-byte compatible with the other Batlink clients (iOS, Android, server).
//
// Envelope: base64url( JSON{ v:2, epk, nonce, ct } )
//   epk   = ephemeral public key, compressed point (33B), base64url
//   nonce = ChaCha20-Poly1305 12B nonce
//   ct    = ciphertext || 16B tag
// Symmetric key = SHA256( KDF_SALT || 33B compressed shared point )
//   Note: the shared point is used as-is in compressed form, not the 32B X coordinate
//   from RFC 5903, and it is not hashed a second time.

import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { keccak_256 } from '@noble/hashes/sha3';
import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { randomBytes } from 'node:crypto';
import { encodeBase64Url, decodeBase64Url } from './base64url.js';

// Wire-level protocol constant shared by every Batlink client. Do not change it,
// or messages will no longer decrypt on the other side.
const KDF_SALT = Buffer.from('windra.e2e.secp256k1.v1', 'utf8');
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/**
 * ECDH shared point (compressed, 33 bytes).
 * @param {Uint8Array} privRaw 32B private key
 * @param {Uint8Array} pubRaw 33B or 65B public key
 */
export function sharedPointCompressed(privRaw, pubRaw) {
  // noble's getSharedSecret returns the shared point itself (not hashed); third arg true = compressed
  return secp256k1.getSharedSecret(privRaw, pubRaw, true);
}

/** Symmetric key = SHA256(salt || 33B shared point) */
export function deriveSymmetricKey(sharedCompressed) {
  return sha256(Buffer.concat([KDF_SALT, Buffer.from(sharedCompressed)]));
}

/**
 * Encrypt: plaintext -> base64url envelope string.
 * @param {string} plainText
 * @param {string} recipientPubB64Url recipient public key (base64url, 33B or 65B)
 */
export function seal(plainText, recipientPubB64Url) {
  const recipientPub = decodeBase64Url(recipientPubB64Url);
  if (!recipientPub || (recipientPub.length !== 33 && recipientPub.length !== 65)) {
    throw new Error('invalid_recipient_pubkey');
  }
  const ephPriv = secp256k1.utils.randomPrivateKey();
  const shared = sharedPointCompressed(ephPriv, recipientPub);
  const key = deriveSymmetricKey(shared);
  const nonce = randomBytes(NONCE_BYTES);
  const ct = chacha20poly1305(key, nonce).encrypt(Buffer.from(plainText, 'utf8'));

  const envelope = {
    v: 2,
    epk: encodeBase64Url(secp256k1.getPublicKey(ephPriv, true)),
    nonce: encodeBase64Url(nonce),
    ct: encodeBase64Url(ct)
  };
  return encodeBase64Url(Buffer.from(JSON.stringify(envelope), 'utf8'));
}

/**
 * Decrypt: base64url envelope string -> plaintext. Throws on failure.
 * @param {string} envelopeB64Url
 * @param {Uint8Array} receiverPrivRaw 32B private key
 */
export function open(envelopeB64Url, receiverPrivRaw) {
  const raw = decodeBase64Url(envelopeB64Url);
  if (!raw) throw new Error('malformed_ciphertext');
  let envelope;
  try {
    envelope = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error('malformed_ciphertext');
  }
  if (envelope?.v !== 2) throw new Error('unsupported_envelope_version');

  const epk = decodeBase64Url(envelope.epk);
  const nonce = decodeBase64Url(envelope.nonce);
  const ct = decodeBase64Url(envelope.ct);
  if (!epk || !nonce || !ct || ct.length < TAG_BYTES) throw new Error('malformed_ciphertext');

  const shared = sharedPointCompressed(receiverPrivRaw, epk);
  const key = deriveSymmetricKey(shared);
  const plain = chacha20poly1305(key, nonce).decrypt(ct);
  return Buffer.from(plain).toString('utf8');
}

/**
 * Wallet signature: secp256k1 ECDSA over SHA256(message); returns the 64B compact (r||s) as base64url.
 * noble normalizes to low-S by default, matching the mobile clients.
 * @param {string|Uint8Array} message
 * @param {Uint8Array} privRaw
 */
export function signPayload(message, privRaw) {
  const data = typeof message === 'string' ? Buffer.from(message, 'utf8') : Buffer.from(message);
  const digest = sha256(data);
  const sig = secp256k1.sign(digest, privRaw, { lowS: true });
  return encodeBase64Url(sig.toCompactRawBytes());
}

/**
 * Verify a signature (used for self-checks and inbound validation).
 * @param {string|Uint8Array} message
 * @param {string} sigB64Url 64B compact
 * @param {string} pubB64Url
 */
export function verifyPayload(message, sigB64Url, pubB64Url) {
  const sig = decodeBase64Url(sigB64Url);
  const pub = decodeBase64Url(pubB64Url);
  if (!sig || sig.length !== 64 || !pub) return false;
  const data = typeof message === 'string' ? Buffer.from(message, 'utf8') : Buffer.from(message);
  try {
    return secp256k1.verify(sig, sha256(data), pub);
  } catch {
    return false;
  }
}

/**
 * ERC20 address = "0x" + last 20 bytes of keccak256(uncompressed public key without the 0x04 prefix), lower-case hex.
 * @param {Uint8Array|string} pub public key (bytes or base64url)
 */
export function erc20AddressFromPublicKey(pub) {
  const raw = typeof pub === 'string' ? decodeBase64Url(pub) : Buffer.from(pub);
  if (!raw || (raw.length !== 33 && raw.length !== 65)) return null;
  const point = secp256k1.ProjectivePoint.fromHex(Buffer.from(raw).toString('hex'));
  const uncompressed = point.toRawBytes(false); // 65B, 0x04 prefix
  const hash = keccak_256(uncompressed.slice(1));
  return '0x' + Buffer.from(hash.slice(-20)).toString('hex');
}

export { sha256, keccak_256 };
