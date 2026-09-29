// Base64URL (no padding). Must match the other Batlink clients exactly
// (Swift Base64URL / Go base64.RawURLEncoding).

/** @param {Uint8Array|Buffer} bytes */
export function encodeBase64Url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

/**
 * Lenient decode: accepts padded or unpadded input, standard or URL alphabet.
 * Returns null when the value cannot be decoded.
 * @param {string} value
 * @returns {Buffer|null}
 */
export function decodeBase64Url(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return Buffer.from(trimmed, 'base64url');
  } catch {
    return null;
  }
}
