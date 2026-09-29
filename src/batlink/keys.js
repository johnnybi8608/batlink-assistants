// Deterministic identities: each (namespace, id) pair maps to one Batlink secp256k1 identity (bots use 'agent', <bot id>).
//
// Only a single master seed has to be stored; the same id always yields the same identity,
// so conversations stay continuous in the app across restarts.
// Derivation: priv = SHA256( masterSeed || 0x00 || namespace || ":" || id || counter )
// counter is only incremented in the vanishingly rare case that the scalar is 0 or not below
// the curve order.
//
// Batlink uses the same secp256k1 key for signing and encryption, so one identity = one private key.

import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { encodeBase64Url } from './base64url.js';
import { erc20AddressFromPublicKey } from './crypto.js';

/**
 * @typedef {Object} Identity
 * @property {Buffer} privateKey      32B private key
 * @property {string} publicKeyB64Url 65B uncompressed public key, base64url (format used by clients and nodes)
 * @property {string} address         0x-prefixed ERC20 address
 * @property {string} platform        namespace string, e.g. "agent"
 * @property {string} contactId       id within the namespace (e.g. the agent id)
 */

/**
 * @param {string} masterSeed
 * @param {string} platform
 * @param {string} contactId
 * @returns {Identity}
 */
export function deriveIdentity(masterSeed, platform, contactId) {
  const base = Buffer.concat([
    Buffer.from(masterSeed, 'utf8'),
    Buffer.from([0x00]),
    Buffer.from(`${platform}:${contactId}`, 'utf8')
  ]);

  for (let counter = 0; counter < 256; counter += 1) {
    const material = counter === 0
      ? base
      : Buffer.concat([base, Buffer.from([counter])]);
    const candidate = Buffer.from(sha256(material));
    if (secp256k1.utils.isValidPrivateKey(candidate)) {
      return finalizeIdentity(candidate, platform, contactId);
    }
  }
  throw new Error(`identity_derivation_failed:${platform}:${contactId}`);
}

function finalizeIdentity(privateKey, platform, contactId) {
  const publicKeyRaw = secp256k1.getPublicKey(privateKey, false); // 65B uncompressed
  const publicKeyB64Url = encodeBase64Url(publicKeyRaw);
  return {
    privateKey,
    publicKeyB64Url,
    address: erc20AddressFromPublicKey(publicKeyRaw),
    platform,
    contactId
  };
}

/** Normalize a public key to raw base64url (accepts 33B/65B; returns null when invalid). */
export function normalizePublicKey(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  let raw;
  try {
    raw = Buffer.from(trimmed, 'base64url');
  } catch {
    return null;
  }
  if (raw.length !== 33 && raw.length !== 65) return null;
  return encodeBase64Url(raw);
}
