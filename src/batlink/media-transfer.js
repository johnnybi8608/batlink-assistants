// Images and voice messages go through Cloudflare R2 (same format as the iOS app):
//
//   send:    encrypt the file with a fresh random AES-256-GCM key (blob = 12-byte nonce | ciphertext | 16-byte tag)
//            -> POST /v1/media/upload for an upload link (size pinned) -> PUT to R2 -> POST /v1/media/complete
//            -> the message only carries media: { v, ticket, key, sha256, size } (still end-to-end encrypted)
//   receive: POST /v1/media/download -> GET -> check sha256 -> decrypt -> handle like an inline image / voice
//            -> POST /v1/media/received (the node deletes the file from R2)
//
// A node without media support (404, or 503 media_disabled) makes uploadMedia return null:
// the caller then sends the file inline as before.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { encodeBase64Url, decodeBase64Url } from './base64url.js';

const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');

export function encryptBlob(plain) {
  const key = randomBytes(32);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { key, blob: Buffer.concat([nonce, body, cipher.getAuthTag()]) };
}

export function decryptBlob(blob, key) {
  if (blob.length < 28) throw new Error('media_blob_too_short');
  const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
  decipher.setAuthTag(blob.subarray(blob.length - 16));
  return Buffer.concat([decipher.update(blob.subarray(12, blob.length - 16)), decipher.final()]);
}

export class MediaError extends Error {
  constructor(kind, detail) {
    super(`${kind}:${detail ?? ''}`);
    this.kind = kind; // 'expired' | 'transient' | 'refused'
  }
}

/** @returns {Promise<{v:number,ticket:string,key:string,sha256:string,size:number}|null>} */
export async function uploadMedia(client, token, { data, kind, recipientPubkey, group = false }) {
  const { key, blob } = encryptBlob(data);
  // group: one copy for the whole group (no single recipient); every member fetches it, the node
  // caps the number of fetches, and it is removed after 48 h
  const body = group ? { kind, size: blob.length, group: true } : { kind, size: blob.length, recipient_pubkey: recipientPubkey };
  const res = await client.mediaCall('/v1/media/upload', body, token);
  const code = res.json?.code;
  if ((res.status === 404 && !code) || code === 'media_disabled') return null;
  if (!res.ok || !res.json?.ticket || !res.json?.upload_url) {
    throw new MediaError('refused', `${res.status}:${code ?? ''}`);
  }
  const put = await fetch(res.json.upload_url, { method: 'PUT', body: blob, headers: { 'Content-Length': String(blob.length) } });
  if (!put.ok) throw new MediaError('transient', `put:${put.status}`);
  const done = await client.mediaCall('/v1/media/complete', { ticket: res.json.ticket }, token);
  if (!done.ok) throw new MediaError('refused', `complete:${done.status}:${done.json?.code ?? ''}`);
  return { v: 1, ticket: res.json.ticket, key: encodeBase64Url(key), sha256: sha256Hex(blob), size: blob.length };
}

/** Download and decrypt. Expired / deleted -> MediaError('expired'); network and the like -> MediaError('transient'). */
export async function downloadMedia(client, token, ref) {
  const res = await client.mediaCall('/v1/media/download', { ticket: ref.ticket }, token);
  const code = res.json?.code;
  // media_download_limit: a group file already fetched its maximum number of times
  if (['media_expired', 'media_ticket_invalid', 'media_not_recipient', 'media_download_limit'].includes(code)) throw new MediaError('expired', code);
  if (!res.ok || !res.json?.download_url) throw new MediaError('transient', `${res.status}:${code ?? ''}`);
  const get = await fetch(res.json.download_url);
  if (get.status === 404) throw new MediaError('expired', 'gone');
  if (!get.ok) throw new MediaError('transient', `get:${get.status}`);
  const blob = Buffer.from(await get.arrayBuffer());
  if (blob.length !== ref.size || sha256Hex(blob) !== String(ref.sha256).toLowerCase()) throw new MediaError('expired', 'hash_mismatch');
  const key = Buffer.from(decodeBase64Url(ref.key));
  if (key.length !== 32) throw new MediaError('expired', 'bad_key');
  try {
    return decryptBlob(blob, key);
  } catch {
    throw new MediaError('expired', 'decrypt_failed');
  }
}

/** Received: ask the node to delete the file from R2 (failure is fine, it is deleted after 48 h anyway). */
export async function confirmMediaReceived(client, token, ref) {
  try {
    await client.mediaCall('/v1/media/received', { ticket: ref.ticket }, token);
  } catch {}
}
