// "Storage format" content inside messages (images, voice, site cards, emoji, ...), compatible with the
// app's message content codec.
//
// Such content is sent as one long text string (prefix + base64url(JSON)). The bot must not write that
// string into the stream as-is: hundreds of KB of noise would end up in the AI context. So on receipt:
//   image -> saved to a file; the stream only gets one line "[图片] <path> (W×H)" (the AI opens the file if needed)
//   voice -> saved to a file; the stream gets "[语音 N 秒] <path>"
//   site / emoji / text with metadata -> converted to one readable line
// Outgoing images are compressed to the app's group image spec: long edge 1280, JPEG, <=160KB.
//
// The stream summaries stay in Chinese because they are read by the (Chinese-speaking) AI personas.

import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { encodeBase64Url, decodeBase64Url } from './batlink/base64url.js';

// Wire-level prefixes shared by every Batlink client. Do not change them.
const PREFIX = {
  image: 'windra_image_v1:',
  voice: 'windra_voice_v1:',
  site: 'windra_site_v1:',
  emoji: 'windra_emoji_v1:',
  textmeta: 'windra_textmeta_v1:',
  transfer: 'windra_transfer_v1:',
  // Group image / voice: the message only carries an R2 reference (one copy for the whole
  // group); on receipt it is downloaded and turned into the usual image / voice storage text
  mediaRef: 'windra_media_ref_v1:'
};

// Same limits the app uses for group / direct images
export const GROUP_IMAGE_MAX_BYTES = 160 * 1024;
export const DIRECT_IMAGE_MAX_BYTES = 320 * 1024;
const IMAGE_MAX_EDGE = 1280;

function decodeStorage(text, prefix) {
  try {
    return JSON.parse(Buffer.from(decodeBase64Url(text.slice(prefix.length))).toString('utf8'));
  } catch {
    return null;
  }
}

const EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/gif': 'gif', 'image/webp': 'webp' };

function emojiFromCode(code) {
  try {
    return String.fromCodePoint(...code.split('-').map((h) => parseInt(h, 16)));
  } catch {
    return '';
  }
}

/**
 * Turn a group message body into readable text for the stream. Plain text is returned unchanged.
 * @param {string} text decrypted body
 * @param {{ mediaDir: string, messageId: string }} opts directory for media files, message id used as file name
 */
export function describeGroupText(text, { mediaDir, messageId, senderRaw }) {
  const safeId = String(messageId ?? randomUUID()).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
  // File name = message id + a tag of the real (signed) sender, written without overwriting: the message id is chosen
  // by the sender, so a group member could otherwise reuse someone else's id and replace that person's picture on disk.
  const senderTag = createHash('sha256').update(String(senderRaw ?? '')).digest('hex').slice(0, 12);
  const writeNew = (ext, data) => {
    let path = join(mediaDir, `${safeId}_${senderTag}.${ext}`);
    try {
      writeFileSync(path, data, { flag: 'wx' });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      path = join(mediaDir, `${safeId}_${senderTag}_${randomUUID().slice(0, 8)}.${ext}`);
      writeFileSync(path, data, { flag: 'wx' });
    }
    return path;
  };

  if (text.startsWith(PREFIX.image)) {
    const s = decodeStorage(text, PREFIX.image);
    if (!s?.imageB64) return '[图片](解析失败)';
    mkdirSync(mediaDir, { recursive: true });
    const path = writeNew(EXT[s.mime] ?? 'jpg', Buffer.from(decodeBase64Url(s.imageB64)));
    return `[图片] ${path} (${s.width}×${s.height})`;
  }
  if (text.startsWith(PREFIX.voice)) {
    const s = decodeStorage(text, PREFIX.voice);
    if (!s?.audioB64) return '[语音](解析失败)';
    mkdirSync(mediaDir, { recursive: true });
    const path = writeNew('m4a', Buffer.from(decodeBase64Url(s.audioB64)));
    const seconds = Math.max(1, Math.round((s.durationMs ?? 0) / 1000));
    const translated = s.bridgeTranslation?.translatedText ? ` 译文:${s.bridgeTranslation.translatedText}` : '';
    return `[语音 ${seconds} 秒] ${path}${translated}`;
  }
  if (text.startsWith(PREFIX.site)) {
    const s = decodeStorage(text, PREFIX.site);
    return s ? `[网站] ${s.title ?? ''} ${s.url ?? ''}`.trim() : '[网站](解析失败)';
  }
  if (text.startsWith(PREFIX.emoji)) {
    const s = decodeStorage(text, PREFIX.emoji);
    return s?.codes?.length ? s.codes.map(emojiFromCode).join('') : '[表情]';
  }
  if (text.startsWith(PREFIX.textmeta)) {
    const s = decodeStorage(text, PREFIX.textmeta);
    return s?.text ?? '[文字](解析失败)';
  }
  if (text.startsWith(PREFIX.transfer)) {
    const s = decodeStorage(text, PREFIX.transfer);
    return s ? `[转账] ${s.amountRaw ?? ''} ${s.symbol ?? ''}`.trim() : '[转账]';
  }
  return text;
}

function sipsSize(path) {
  const out = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', path], { encoding: 'utf8' });
  return {
    width: Number(out.match(/pixelWidth:\s*(\d+)/)?.[1] ?? 0),
    height: Number(out.match(/pixelHeight:\s*(\d+)/)?.[1] ?? 0)
  };
}

/**
 * Compress to the app's group image spec using macOS's built-in sips: start at long edge 1280 and JPEG
 * quality 80 -> 20; if still over the limit, scale the edge by 0.82 and retry, up to 4 rounds.
 * @returns {{ data: Buffer, width: number, height: number, mime: string }}
 */
export function compressImageForGroup(inputPath, maxBytes = GROUP_IMAGE_MAX_BYTES) {
  if (!existsSync(inputPath)) throw new Error(`image not found: ${inputPath}`);
  const source = sipsSize(inputPath);
  if (!source.width || !source.height) throw new Error(`not a recognizable image: ${inputPath}`);
  const work = join(tmpdir(), `batlink-img-${randomUUID()}`);
  mkdirSync(work, { recursive: true });
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const edge = Math.floor(IMAGE_MAX_EDGE * 0.82 ** attempt);
      for (let quality = 80; quality >= 20; quality -= 10) {
        const out = join(work, `a${attempt}-q${quality}.jpg`);
        const args = ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(quality)];
        if (Math.max(source.width, source.height) > edge) args.push('-Z', String(edge));
        execFileSync('sips', [...args, inputPath, '--out', out], { stdio: 'ignore' });
        const data = readFileSync(out);
        if (data.length <= maxBytes) {
          const { width, height } = sipsSize(out);
          return { data, width, height, mime: 'image/jpeg' };
        }
      }
    }
    throw new Error(`could not compress the image below ${Math.round(maxBytes / 1024)}KB (too complex); use another image or crop it first`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Same as the app's group image reference: only the R2 reference travels */
export function makeImageRefStorageText({ media, width, height, mime }) {
  const storage = { kind: 'image', media, mime, width, height };
  return PREFIX.mediaRef + encodeBase64Url(Buffer.from(JSON.stringify(storage), 'utf8'));
}

/** Is this group text an R2 reference? Returns {kind, media, mime, width, height, durationMs, waveform} */
export function parseMediaRefStorageText(text) {
  if (!text.startsWith(PREFIX.mediaRef)) return null;
  const s = decodeStorage(text, PREFIX.mediaRef);
  return s?.media?.ticket ? s : null;
}

/** Same as the app's voice storage text: prefix + base64url(JSON{durationMs,audioB64,waveform}) */
export function makeVoiceStorageText({ data, durationMs, waveform = null }) {
  const storage = { durationMs, audioB64: encodeBase64Url(data), waveform };
  return PREFIX.voice + encodeBase64Url(Buffer.from(JSON.stringify(storage), 'utf8'));
}

/** Same as the app's image storage text: prefix + base64url(JSON{mime,width,height,bytes,imageB64}) */
export function makeImageStorageText({ data, width, height, mime }) {
  const storage = { mime, width, height, bytes: data.length, imageB64: encodeBase64Url(data) };
  return PREFIX.image + encodeBase64Url(Buffer.from(JSON.stringify(storage), 'utf8'));
}

/**
 * Turn a direct message (app wire payload JSON) into readable text for the stream; reactions and the like
 * return null (not recorded). Quoted replies are prefixed with "[引用: <quoted content>]".
 */
export function describePrivateWire(wire, { mediaDir, messageId }) {
  if (!wire || typeof wire !== 'object') return null;
  if (wire.reactionTargetId) return null;
  const safeId = String(messageId ?? randomUUID()).replace(/[^A-Za-z0-9_-]/g, '');
  let body;
  switch (wire.type) {
    case 'image': {
      if (!wire.imageB64) { body = '[图片](解析失败)'; break; }
      mkdirSync(mediaDir, { recursive: true });
      const path = join(mediaDir, `${safeId}.${EXT[wire.imageMime] ?? 'jpg'}`);
      writeFileSync(path, Buffer.from(decodeBase64Url(wire.imageB64)));
      body = `[图片] ${path} (${wire.imageWidth}×${wire.imageHeight})`;
      break;
    }
    case 'voice': {
      if (!wire.voiceB64) { body = '[语音](解析失败)'; break; }
      mkdirSync(mediaDir, { recursive: true });
      const path = join(mediaDir, `${safeId}.m4a`);
      writeFileSync(path, Buffer.from(decodeBase64Url(wire.voiceB64)));
      body = `[语音 ${Math.max(1, Math.round((wire.durationMs ?? 0) / 1000))} 秒] ${path}`;
      break;
    }
    case 'emoji':
      body = (wire.emojiCodes ?? []).map(emojiFromCode).join('') || '[表情]';
      break;
    case 'site':
      body = `[网站] ${wire.siteTitle ?? ''} ${wire.siteUrl ?? ''}`.trim();
      break;
    case 'text':
      body = wire.text ?? '';
      break;
    default:
      body = wire.text ?? `[${wire.type ?? '未知'}消息]`;
  }
  if (!body) return null;
  if (wire.replyToPreviewText) {
    body = `[引用: ${String(wire.replyToPreviewText).slice(0, 300)}]\n${body}`;
  }
  return body;
}
