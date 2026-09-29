// Mail operations, executed by this program on behalf of the mail assistant (which can only *request* them):
// search, read a message, read a thread, create a draft.
// Attachments are **never opened** (a malicious file is a real risk): the assistant only sees their names and sizes.
// There is deliberately **no send** here. Sending happens only in the mail watcher, after the owner
// personally replies "发送".
// Errors thrown here are in Chinese on purpose: they are fed back to the assistant or shown to the owner.

import { GmailAccount } from './gmail.js';
import { parseMessage, formatSize } from './parse.js';
import { loadIndex, loadState, withIndex, lookupMessage, assignMessageNo, mailAccounts, labelOf } from './store.js';

const accounts = new Map();
export function gmailFor(accountId) {
  if (!accounts.has(accountId)) accounts.set(accountId, new GmailAccount(accountId));
  return accounts.get(accountId);
}

/** Gmail message id → "#N" (only messages that were pushed or found by search have one). */
function noOf(accountId, id) {
  const entry = Object.entries(loadIndex().messages).find(([, info]) => info.account === accountId && info.id === id);
  return entry ? `#${entry[0]}` : null;
}

export function mailText(config, accountId, mail) {
  const tag = noOf(accountId, mail.id);
  const lines = [`【${labelOf(config, accountId)}】${tag ? `邮件 ${tag}` : `邮件 id ${mail.id}`}`, `时间:${mail.date}`, `发件人:${mail.from}`, `收件人:${mail.to}`];
  if (mail.cc) lines.push(`抄送:${mail.cc}`);
  lines.push(`主题:${mail.subject}`);
  if (mail.attachments.length) lines.push(`附件(不会打开,只有文件名):${mail.attachments.map((a) => `${a.filename}(${formatSize(a.size)})`).join('、')}`);
  lines.push('', mail.body || '(正文为空)');
  return lines.join('\n');
}

/** Reference "#12" or {account, id} → { accountId, id }. */
export function resolveRef(ref, fallbackAccount) {
  if (ref && typeof ref === 'object' && ref.id) return { accountId: ref.account ?? fallbackAccount, id: ref.id };
  const info = lookupMessage(ref);
  if (info) return { accountId: info.account, id: info.id };
  throw new Error(`找不到邮件 ${ref}(只认推送过的 #编号)`);
}

export async function readMail(config, ref) {
  const { accountId, id } = resolveRef(ref);
  const mail = parseMessage(await gmailFor(accountId).getMessage(id));
  return { accountId, mail, text: mailText(config, accountId, mail) };
}

export async function readThread(config, ref) {
  const { accountId, id } = resolveRef(ref);
  const gmail = gmailFor(accountId);
  const first = parseMessage(await gmail.getMessage(id));
  const thread = await gmail.getThread(first.threadId);
  const texts = thread.messages.map((m) => mailText(config, accountId, parseMessage(m)));
  return `【整个往来,共 ${texts.length} 封,按时间顺序】\n\n${texts.join('\n\n==========\n\n')}`;
}

export async function searchMail(config, accountId, query, max = 10) {
  const ids = accountId ? [accountId] : mailAccounts(config).filter((a) => a.provider === 'gmail').map((a) => a.id);
  const out = [];
  for (const acc of ids) {
    const gmail = gmailFor(acc);
    if (!gmail.authorized) continue;
    const res = await gmail.search(query, max);
    for (const m of res.messages ?? []) {
      const mail = parseMessage(await gmail.getMessage(m.id));
      // Search results (including old mail from before the assistant was set up) get a #number too, so they
      // can be read, opened, followed as a thread and replied to like pushed mail
      const no = noOf(acc, mail.id) ?? `#${await assignMessageNo({ account: acc, id: mail.id, threadId: mail.threadId, from: mail.from, subject: mail.subject, date: mail.date, fromSearch: true })}`;
      out.push(`【${labelOf(config, acc)}】${no}  ${mail.date}\n  发件人:${mail.from}\n  主题:${mail.subject}\n  摘要:${mail.body.slice(0, 200).replace(/\s+/g, ' ')}`);
    }
  }
  return out.length ? out.join('\n\n') : `(没有找到符合「${query}」的邮件)`;
}

// ---------- Drafts ----------

const encodeHeader = (value) => (/^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`);
const addresses = (value) => (value ?? '').split(',').map((s) => (s.match(/<([^>]+)>/)?.[1] ?? s).trim()).filter(Boolean);

function buildRaw({ to, cc, subject, body, inReplyTo, references }) {
  const headers = [`To: ${to}`];
  if (cc) headers.push(`Cc: ${cc}`);
  headers.push(`Subject: ${encodeHeader(subject)}`);
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`);
  if (references) headers.push(`References: ${references}`);
  headers.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64');
  const content = Buffer.from(body, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${content}`, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Create a draft (never sends). Reply: { replyTo: "#12", replyAll?, cc?, body }; new mail: { account, to, cc?, subject, body }.
 * Error messages are in Chinese because they are shown to the owner / fed back to the assistant.
 * @returns {Promise<{ no: number, accountId: string, to: string, subject: string }>}
 */
export async function createDraft(config, spec) {
  const body = String(spec.body ?? '').trim();
  if (!body) throw new Error('草稿正文是空的');
  let accountId; let to; let cc; let subject; let threadId; let inReplyTo; let references;
  if (spec.replyTo) {
    const ref = resolveRef(spec.replyTo);
    accountId = ref.accountId;
    const original = parseMessage(await gmailFor(accountId).getMessage(ref.id));
    const me = (loadState(accountId).address ?? '').toLowerCase();
    to = original.replyTo || original.from;
    if (spec.replyAll) {
      const others = [...addresses(original.to), ...addresses(original.cc)].filter((a) => a.toLowerCase() !== me && !addresses(to).includes(a));
      cc = [...new Set(others)].join(', ') || undefined;
    }
    if (spec.cc) cc = [cc, spec.cc].filter(Boolean).join(', ');
    subject = spec.subject || (/^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`);
    threadId = original.threadId;
    inReplyTo = original.messageIdHeader || undefined;
    references = [original.references, original.messageIdHeader].filter(Boolean).join(' ') || undefined;
  } else {
    accountId = spec.account;
    to = spec.to;
    cc = spec.cc;
    subject = spec.subject;
    if (!accountId || !mailAccounts(config).some((m) => m.id === accountId)) throw new Error(`新邮件要指定从哪个邮箱发(account),可选:${mailAccounts(config).map((m) => `${m.id}(${m.label})`).join('、')}`);
    if (!to || !subject) throw new Error('新邮件需要 to 和 subject');
  }
  const draft = await gmailFor(accountId).createDraft(buildRaw({ to, cc, subject, body, inReplyTo, references }), threadId);
  const no = await withIndex((index) => {
    const n = index.nextDraftNo;
    index.nextDraftNo += 1;
    index.drafts[n] = { account: accountId, draftId: draft.id, threadId: draft.message?.threadId ?? threadId ?? null, to, cc: cc ?? null, subject, status: 'pending', createdAt: new Date().toISOString() };
    return n;
  });
  return { no, accountId, to, subject };
}
