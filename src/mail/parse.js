// Gmail message (format=full) → plain text: from / cc / subject / body / attachments.
// The body prefers text/plain and falls back to text/html converted to text; quoted history from replies is
// stripped so only the newly written part remains.

import { decodeBase64Url } from '../batlink/base64url.js';

const header = (msg, name) =>
  msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

function decodePart(data) {
  if (!data) return '';
  return Buffer.from(decodeBase64Url(data)).toString('utf8');
}

/** Walk the MIME tree, collecting body parts and attachments. */
function walk(part, out) {
  if (!part) return;
  const mime = (part.mimeType ?? '').toLowerCase();
  const filename = part.filename ?? '';
  if (filename && (part.body?.attachmentId || part.body?.data)) {
    // small attachments are embedded (body.data, no attachmentId): keep the bytes, they are part of what is sent
    out.attachments.push({ filename, mimeType: mime, size: part.body?.size ?? 0, attachmentId: part.body?.attachmentId ?? null, data: part.body?.attachmentId ? null : (part.body?.data ?? null) });
    return;
  }
  if (mime === 'text/plain' && !out.plain) out.plain = decodePart(part.body?.data);
  else if (mime === 'text/html' && !out.html) out.html = decodePart(part.body?.data);
  for (const child of part.parts ?? []) walk(child, out);
}

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©' };

export function htmlToText(html, { keepQuotes = false } = {}) {
  let s = html;
  // Drop Gmail / Outlook quote blocks (history carried along in replies) first — unless the full text is wanted
  if (!keepQuotes) s = s.replace(/<div[^>]*class="[^"]*gmail_quote[^"]*"[\s\S]*$/i, '');
  if (!keepQuotes) s = s.replace(/<blockquote[\s\S]*?<\/blockquote>/gi, '');
  if (!keepQuotes) s = s.replace(/<div[^>]*id="?(divRplyFwdMsg|appendonsend)"?[\s\S]*$/i, '');
  s = s.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|table)>/gi, '\n');
  s = s.replace(/<li[^>]*>/gi, '• ');
  s = s.replace(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
    const t = text.replace(/<[^>]+>/g, '').trim();
    return t && !href.startsWith('mailto:') && t !== href ? `${t}(${href})` : t || href;
  });
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
  return s;
}

/** Strip quoted history from plain text: everything after "On … wrote:" / "在 … 写道:" / "-----Original Message-----" / an Outlook separator, plus lines starting with ">". */
export function stripQuoted(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const t = line.trim();
    if (/^On .{5,200} wrote:$/i.test(t) || /^在.{2,200}写道[:：]$/.test(t) || /^-{2,}\s*(Original Message|原始邮件|Forwarded message|转发的邮件)\s*-{2,}$/i.test(t)) break;
    if (/^_{8,}$/.test(t) && /^(From|发件人)[:：]/i.test((lines[i + 1] ?? '').trim())) break;
    if (/^(From|发件人)[:：]\s*\S+/i.test(t) && /^(Sent|Date|发送时间|时间)[:：]/i.test((lines[i + 1] ?? '').trim())) break;
    if (t.startsWith('>')) continue;
    out.push(line);
  }
  return out.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** @returns {{ id, threadId, from, to, cc, replyTo, subject, date, messageIdHeader, references, body, attachments, labelIds }} */
export function parseMessage(msg) {
  const out = { plain: '', html: '', attachments: [] };
  walk(msg.payload, out);
  const raw = out.plain || (out.html ? htmlToText(out.html) : msg.snippet ?? '');
  return {
    id: msg.id,
    threadId: msg.threadId,
    labelIds: msg.labelIds ?? [],
    from: header(msg, 'From'),
    to: header(msg, 'To'),
    cc: header(msg, 'Cc'),
    bcc: header(msg, 'Bcc'),
    replyTo: header(msg, 'Reply-To'),
    subject: header(msg, 'Subject') || '(无主题)',
    date: header(msg, 'Date'),
    messageIdHeader: header(msg, 'Message-ID') || header(msg, 'Message-Id'),
    references: header(msg, 'References'),
    body: stripQuoted(raw),
    // Everything, quotes included, and the exact raw parts — used where "what is actually sent" matters (draft confirmation)
    fullText: (out.plain || (out.html ? htmlToText(out.html, { keepQuotes: true }) : '')).replace(/\r\n/g, '\n'),
    rawParts: [out.plain, out.html],
    attachments: out.attachments
  };
}

export function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

/**
 * Is the text Chinese: Han characters make up the majority of letter-like tokens and there is almost no
 * Japanese kana / Korean hangul. Mixed Chinese/English text goes by whichever dominates.
 */
export function isChinese(text) {
  const han = (text.match(/[一-鿿㐀-䶿]/g) ?? []).length;
  const kana = (text.match(/[぀-ヿ]/g) ?? []).length;
  const hangul = (text.match(/[가-힯]/g) ?? []).length;
  const latinWords = (text.match(/[A-Za-zÀ-ɏ]+/g) ?? []).length;
  if (kana > 5 || hangul > 5) return false;
  // One Han character counts roughly as one English word
  return han > 0 && han >= latinWords;
}
