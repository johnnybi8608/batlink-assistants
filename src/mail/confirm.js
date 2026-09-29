// Draft confirmation for the mail assistant: what would really be sent, and the preview the owner confirms.
// Kept separate from bin/mailwatch.js so it can be tested with a fake Gmail client.

import { createHash } from 'node:crypto';
import { parseMessage, formatSize } from './parse.js';

const norm = (t) => String(t).replace(/^[\s>]+/, '').replace(/\s+/g, ' ').trim();

/**
 * What would really be sent: every recipient (To / Cc / Bcc), the subject, the complete body (every part, quotes
 * included) and the attachments' actual bytes. The confirmation hash covers all of it, so any change after the owner
 * saw the preview requires a new confirmation.
 * The preview shows the new text; every other line of the full body that is NOT in the email being replied to is
 * listed as "hidden" (wherever it sits — before, inside or after the quote), so nothing goes out unseen.
 * If an attachment cannot be read, the draft is blocked: it cannot be confirmed or sent.
 */
export async function draftSnapshot(gmail, draftId) {
  const draft = await gmail.getDraft(draftId);
  const mail = parseMessage(draft.message);
  const headerOf = (name) => draft.message.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? '';
  const to = headerOf('to');
  const bcc = headerOf('bcc');
  const attachments = [];
  let blocked = null;
  for (const a of mail.attachments) {
    let bytes = null;
    try {
      const data = a.data ?? (a.attachmentId ? (await gmail.getAttachment(draft.message.id, a.attachmentId)).data : null);
      if (typeof data === 'string') bytes = Buffer.from(data, 'base64url');
    } catch {}
    if (!bytes) blocked ??= `附件「${a.filename}」读不到`;
    attachments.push({ filename: a.filename, mimeType: a.mimeType, size: a.size, sha256: bytes ? createHash('sha256').update(bytes).digest('hex') : null });
  }
  // Lines of the full body that the preview's new text does not show, minus what is in the original thread
  const shown = new Set(mail.body.split('\n').map(norm).filter(Boolean));
  const extra = mail.fullText.split('\n').map(norm).filter((l) => l && !shown.has(l) && !/^(On .{5,200} wrote:|在.{2,200}写道[:：])$/i.test(l));
  let hidden = [];
  if (extra.length) {
    let original = '';
    try {
      const thread = draft.message.threadId ? await gmail.getThread(draft.message.threadId) : null;
      original = (thread?.messages ?? []).filter((m) => m.id !== draft.message.id && !(m.labelIds ?? []).includes('DRAFT'))
        .map((m) => parseMessage(m).fullText).join('\n');
    } catch {}
    const known = norm(original);
    hidden = extra.filter((l) => !known.includes(l));
  }
  const hash = createHash('sha256').update(JSON.stringify([to, mail.cc, bcc, mail.subject, mail.rawParts, attachments.map((a) => [a.filename, a.size, a.sha256]), blocked])).digest('hex');
  return { to, cc: mail.cc, bcc, subject: mail.subject, body: mail.body, quotedLines: extra.length, hidden, attachments, blocked, hash };
}

export function previewText(no, label, snap, note = '') {
  const lines = [`📝 ${label} 草稿 D${no}${note ? `(${note})` : ''}`, `收件人:${snap.to}`];
  if (snap.cc) lines.push(`抄送:${snap.cc}`);
  if (snap.bcc) lines.push(`⚠️ 密送:${snap.bcc}`);
  lines.push(`主题:${snap.subject}`);
  if (snap.attachments.length) lines.push(`附件:${snap.attachments.map((a) => `${a.filename}(${formatSize(a.size)})`).join('、')}`);
  lines.push('', snap.body || '(正文为空)');
  if (snap.hidden.length) {
    lines.push('', `⚠️ 正文里还有 ${snap.hidden.length} 行不是原邮件的引用,上面没显示,也会一起发出:`, ...snap.hidden.slice(0, 50).map((l) => `> ${l}`));
    if (snap.hidden.length > 50) lines.push(`……还有 ${snap.hidden.length - 50} 行`);
  } else if (snap.quotedLines) {
    lines.push('', `(另外附带引用的原邮件 ${snap.quotedLines} 行,和原邮件一致)`);
  }
  if (snap.blocked) {
    lines.push('', `⛔ ${snap.blocked},这封草稿不能确认发送。请在邮箱里检查附件,或让我重新拟一份。`);
    return lines.join('\n');
  }
  lines.push('', `—— 以上是实际会从「${label}」发出去的内容。引用这条回复「发送」,或回复「发送 D${no}」——`);
  return lines.join('\n');
}

