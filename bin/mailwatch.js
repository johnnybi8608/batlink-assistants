#!/usr/bin/env node
// Mail watcher (a long-running process; run it under launchd or any process manager):
//   1. Checks every mailbox's INBOX for new mail (Gmail API history) every config.mail.pollSeconds and pushes
//      each message as its own private message to the owner, from the mail assistant bot (config.mail.agent):
//      mailbox label #number / from / cc / subject / attachments / body; non-Chinese mail also gets a
//      translation (one-shot, zero-tool model call, see src/mail/translate.js).
//      Ads / promotions / likely spam (Gmail's Promotions category + a model verdict, zero tools) are pushed
//      as a short summary card only; the owner replies "原文" to get the full text. Pushed mail is marked read.
//   2. When the assistant has created a draft, the watcher reads the draft's **actual content** back from
//      Gmail and pushes it to the owner for confirmation (not the AI's paraphrase of it).
//   3. The owner replies "发送" in the private chat with the assistant (or "发送 D3", or quotes the draft
//      confirmation and says "发送") → the watcher checks the draft has not changed since it was shown → sends.
//      Only messages the owner personally sent count (Batlink messages carry the sender's signature, the AI
//      cannot forge them); the AI side has no way to send mail at all.
//
// Configuration: config.json → "mail" (field list in src/mail/store.js). Mailboxes are added by bin/mail-auth.js.
// Blocked / filtered mail ends up in Spam or Trash, not in INBOX, so it is never pushed.

import { readFileSync, writeFileSync, renameSync, existsSync, statSync, openSync, readSync, closeSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { GmailAccount } from '../src/mail/gmail.js';
import { parseMessage, formatSize, isChinese } from '../src/mail/parse.js';
import { translateToChinese, analyzeMail } from '../src/mail/translate.js';
import { loadConfig, mailSettings, accountOf, dataDirOf, mailRoot, loadState, saveState, loadIndex, withIndex, assignMessageNo } from '../src/mail/store.js';
import { localFetch } from '../src/local.js';
import { draftSnapshot as snapshotOf, previewText as previewOf } from '../src/mail/confirm.js';

const startConfig = loadConfig();
const dataDir = dataDirOf(startConfig);
const port = String(startConfig.httpPort ?? 8790);
const COMMAND_MS = 3_000;
const BODY_MAX = 3500; // longest body pushed; longer ones are truncated (the assistant can read the full text)

const logFile = join(dataDir, 'mailwatch.log');
mkdirSync(dataDir, { recursive: true });
function log(msg, extra = {}) {
  appendFileSync(logFile, JSON.stringify({ t: new Date().toISOString(), msg, ...extra }) + '\n');
}

const settings = () => mailSettings(loadConfig());
const mailAgent = () => settings().agent;
const labelOf = (accountId) => accountOf(loadConfig(), accountId)?.label ?? accountId;
const addressOf = (accountId) => accountOf(loadConfig(), accountId)?.address || loadState(accountId).address || '';
const translateOptions = () => settings().translate;
const gmails = new Map();
const gmailFor = (id) => { if (!gmails.has(id)) gmails.set(id, new GmailAccount(id)); return gmails.get(id); };

async function dm(text) {
  const res = await localFetch(`/dm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // origin is shown to the assistant in its context as "<bot name>·邮件监听器" (these pushes are not its own words)
    body: JSON.stringify({ agent: mailAgent(), text, origin: '邮件监听器' })
  });
  if (!res.ok) throw new Error(`Private message push failed: ${res.status}`);
}

function truncate(text, max) {
  return text.length <= max ? { text, cut: false } : { text: `${text.slice(0, max)}…`, cut: true };
}

// ---------- 1. Pushing new mail ----------

function buildPush(accountId, no, mail, translation) {
  const lines = [`📧 ${labelOf(accountId)} #${no}`, `发件人:${mail.from}`];
  if (mail.cc) lines.push(`抄送:${mail.cc}`);
  lines.push(`主题:${mail.subject}`);
  if (mail.attachments.length) lines.push(`附件:${mail.attachments.map((a) => `${a.filename}(${formatSize(a.size)})`).join('、')}`);
  const body = truncate(mail.body || '(正文为空)', BODY_MAX);
  lines.push('', body.text);
  if (body.cut) lines.push('(正文太长,已截断。引用这条让我"看全文")');
  if (translation) lines.push('', '—— 译文 ——', translation);
  return lines.join('\n');
}

/** Summary cards carry nothing clickable or dialable: links, domains and phone numbers are removed. */
function sanitize(text) {
  return String(text ?? '')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, '')
    .replace(/\b[\w.-]+\.(?:com|net|org|io|cn|co|info|biz|top|xyz|shop|link|click)(?:\/\S*)?/gi, '')
    .replace(/\+?\d[\d\s-]{7,}\d/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function buildSummaryCard(accountId, no, mail, kind, summary) {
  return [
    `📧 ${labelOf(accountId)} #${no} · ${kind === 'spam' ? '疑似垃圾邮件' : '疑似广告'}`,
    `收件:${addressOf(accountId)}`,
    `发件:${sanitize(mail.from)}`,
    `主题:${sanitize(mail.subject)}`,
    `大意:${sanitize(summary) || '(没能概括)'}`,
    '',
    '⚠️ 可能判断有误。想看原文就回复「原文」(或引用这条说「原文」),也可以去邮箱里查看。'
  ].join('\n');
}

async function translationFor(accountId, no, mail) {
  if (isChinese(`${mail.subject}\n${mail.body}`)) return null;
  try {
    return await translateToChinese(`主题:${mail.subject}\n\n${truncate(mail.body, BODY_MAX).text}`, translateOptions());
  } catch (error) {
    log('translation failed', { account: accountId, no, err: String(error).slice(0, 300) });
    return '(翻译失败,上面是原文。可以引用这条让我再翻一次)';
  }
}

/** Mark as read after a successful push; without the gmail.modify scope (old authorisation) log once only. */
const markReadWarned = new Set();
async function markRead(accountId, messageId) {
  try {
    await gmailFor(accountId).markRead(messageId);
  } catch (error) {
    if (!markReadWarned.has(accountId)) log('mark-read failed (mailbox may need re-authorising for gmail.modify)', { account: accountId, err: String(error.message ?? error).slice(0, 200) });
    markReadWarned.add(accountId);
  }
}

async function pushOne(accountId, messageId) {
  const mail = parseMessage(await gmailFor(accountId).getMessage(messageId));
  if (!mail.labelIds.includes('INBOX')) return;
  const no = await assignMessageNo({ account: accountId, id: mail.id, threadId: mail.threadId, from: mail.from, subject: mail.subject, date: mail.date });
  // Ad / spam check first: Gmail's Promotions category + the model's verdict (on model errors the mail is
  // pushed as normal, so nothing is lost)
  const gmailCategory = mail.labelIds.includes('CATEGORY_PROMOTIONS') ? '推广' : mail.labelIds.includes('CATEGORY_SOCIAL') ? '社交' : mail.labelIds.includes('CATEGORY_UPDATES') ? '动态' : '';
  let verdict = { kind: 'normal', summary: '' };
  try {
    verdict = await analyzeMail({ from: mail.from, subject: mail.subject, body: mail.body, gmailCategory }, translateOptions());
    if (verdict.kind === 'normal' && gmailCategory === '推广') verdict.kind = 'promo';
  } catch (error) {
    log('classification failed, pushing as normal mail', { account: accountId, no, err: String(error).slice(0, 300) });
  }
  if (verdict.kind !== 'normal') {
    await dm(buildSummaryCard(accountId, no, mail, verdict.kind, verdict.summary));
    await withIndex((index) => { if (index.messages[no]) index.messages[no].summarized = verdict.kind; });
    await markRead(accountId, mail.id);
    log('pushed summary', { account: accountId, no, kind: verdict.kind, from: mail.from, subject: mail.subject.slice(0, 80) });
    return;
  }
  const translation = await translationFor(accountId, no, mail);
  await dm(buildPush(accountId, no, mail, translation));
  await markRead(accountId, mail.id);
  log('pushed', { account: accountId, no, from: mail.from, subject: mail.subject.slice(0, 80), translated: Boolean(translation) });
}

/** The owner wants the original of a (summarised) mail: push full text + translation; without a number, the latest summarised one. */
async function pushOriginal(no) {
  const index = loadIndex();
  if (!no) {
    no = Object.keys(index.messages).map(Number).filter((n) => index.messages[n].summarized).sort((a, b) => b - a)[0];
    if (!no) return dm('最近没有被当成广告摘要的邮件。要看哪封?引用那条推送说「原文」。');
  }
  const info = index.messages[no];
  if (!info) return dm(`⚠️ 找不到 #${no}(编号太旧或者不存在)。`);
  try {
    const mail = parseMessage(await gmailFor(info.account).getMessage(info.id));
    await dm(buildPush(info.account, no, mail, await translationFor(info.account, no, mail)));
    log('pushed original', { account: info.account, no });
  } catch (error) {
    log('pushing original failed', { no, err: String(error).slice(0, 300) });
    await dm(`❌ #${no} 原文取不到:${String(error.message ?? error).slice(0, 200)}`);
  }
}

async function pollAccount(accountId) {
  const gmail = gmailFor(accountId);
  const state = loadState(accountId);
  if (!state.historyId) {
    const profile = await gmail.profile(); // first run: start from now, do not push older mail
    saveState(accountId, { ...state, historyId: profile.historyId, address: profile.emailAddress, pushed: [] });
    log('watching started', { account: accountId, address: profile.emailAddress });
    return;
  }
  let result;
  try {
    result = await gmail.newInboxMessageIds(state.historyId);
  } catch (error) {
    if (error.status !== 404) throw error;
    const profile = await gmail.profile(); // historyId too old (watcher was down for long): restart from now
    saveState(accountId, { ...loadState(accountId), historyId: profile.historyId });
    log('history expired, restarting from now', { account: accountId });
    return;
  }
  for (const id of result.ids) {
    if ((loadState(accountId).pushed ?? []).includes(id)) continue;
    await pushOne(accountId, id); // one message per push, in arrival order; recorded one by one so a failure resumes here next time
    const s = loadState(accountId);
    saveState(accountId, { ...s, pushed: [...(s.pushed ?? []), id].slice(-1000) });
  }
  saveState(accountId, { ...loadState(accountId), historyId: result.historyId });
}

// ---------- 2. Draft confirmation: the watcher reads the actual content from Gmail itself ----------

// draftSnapshot / previewText: src/mail/confirm.js
const draftSnapshot = (accountId, draftId) => snapshotOf(gmailFor(accountId), draftId);
const previewText = (no, draft, snap, note = '') => previewOf(no, labelOf(draft.account), snap, note);

async function showPendingDrafts() {
  for (const [no, draft] of Object.entries(loadIndex().drafts)) {
    if (draft.status !== 'pending' || draft.shownHash) continue;
    const snap = await draftSnapshot(draft.account, draft.draftId);
    await withIndex((index) => { index.drafts[no] = { ...index.drafts[no], shownHash: snap.hash, shownAt: new Date().toISOString() }; });
    await dm(previewText(no, draft, snap));
    log('draft pushed for confirmation', { account: draft.account, no });
  }
}

// ---------- 3. Sending: only on the owner's own "发送" in the private chat with the assistant ----------

function readNewDmEvents() {
  const file = join(dataDir, 'streams', mailAgent(), 'dm.jsonl');
  if (!existsSync(file)) return [];
  const cursorPath = join(mailRoot(), 'dm-cursor.json');
  mkdirSync(mailRoot(), { recursive: true });
  let offset;
  try { offset = JSON.parse(readFileSync(cursorPath, 'utf8')).offset; } catch { offset = statSync(file).size; }
  const size = statSync(file).size;
  if (size < offset) offset = 0;
  const events = [];
  if (size > offset) {
    const fd = openSync(file, 'r');
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    closeSync(fd);
    const text = buf.toString('utf8');
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline >= 0) {
      for (const line of text.slice(0, lastNewline).split('\n')) {
        try { events.push(JSON.parse(line)); } catch {}
      }
      offset += Buffer.byteLength(text.slice(0, lastNewline + 1), 'utf8');
    }
  }
  const tmp = `${cursorPath}.tmp`; // written synchronously so the next round always sees the new offset
  writeFileSync(tmp, JSON.stringify({ offset }));
  renameSync(tmp, cursorPath);
  return events;
}

async function sendDraft(no) {
  const draft = loadIndex().drafts[no];
  if (!draft) return dm(`⚠️ 没有草稿 D${no}。`);
  if (draft.status === 'sent') return dm(`D${no} 之前已经发出过了,没有重复发送。`);
  try {
    const snap = await draftSnapshot(draft.account, draft.draftId);
    if (snap.blocked) {
      log('draft blocked, not sent', { account: draft.account, no, reason: snap.blocked });
      return dm(`⛔ D${no} 没有发送:${snap.blocked}。`);
    }
    if (!draft.shownHash || snap.hash !== draft.shownHash) {
      // What the owner saw is not the current version: do not send, push the actual content again
      await withIndex((index) => { index.drafts[no] = { ...index.drafts[no], shownHash: snap.hash, shownAt: new Date().toISOString() }; });
      log('draft changed since shown, not sent, asked again', { account: draft.account, no });
      return dm(previewText(no, draft, snap, '内容和你之前看到的不一样,没有发送,请看这一版'));
    }
    await gmailFor(draft.account).sendDraft(draft.draftId);
    await withIndex((index) => { index.drafts[no] = { ...index.drafts[no], status: 'sent', sentAt: new Date().toISOString() }; });
    log('draft sent', { account: draft.account, no, to: snap.to, subject: snap.subject });
    return dm(`✅ 已从「${labelOf(draft.account)}」发出 D${no}\n收件人:${snap.to}${snap.cc ? `\n抄送:${snap.cc}` : ''}\n主题:${snap.subject}`);
  } catch (error) {
    log('sending draft failed', { account: draft.account, no, err: String(error).slice(0, 300) });
    return dm(`❌ D${no} 发送失败:${String(error.message ?? error).slice(0, 200)}`);
  }
}

async function handleCommands() {
  await showPendingDrafts();
  for (const event of readNewDmEvents()) {
    if (event.senderRole !== 'owner') continue;
    if (event.command === 'mail_original') {
      await pushOriginal(event.mailNo);
      continue;
    }
    if (event.command !== 'mail_send') continue;
    if (event.draftNo) {
      await sendDraft(event.draftNo);
      continue;
    }
    // No number given: send the only waiting draft; with several, ask which one
    const waiting = Object.entries(loadIndex().drafts).filter(([, d]) => d.status === 'pending' && d.shownHash);
    if (waiting.length === 1) await sendDraft(Number(waiting[0][0]));
    else if (!waiting.length) await dm('现在没有等你确认的草稿。');
    else await dm(`有 ${waiting.length} 份草稿在等确认,发哪一份?回复「发送 D编号」,或引用那条草稿确认消息说「发送」:\n${waiting.map(([n, d]) => `D${n}  ${labelOf(d.account)} → ${d.to}  ${d.subject}`).join('\n')}`);
  }
}

// ---------- Main loop ----------

const lastPoll = new Map();
const warned = new Set();
async function tick() {
  try {
    await handleCommands();
  } catch (error) {
    log('command handling failed', { err: String(error.message ?? error).slice(0, 300) });
  }
  const { accounts, pollSeconds } = settings();
  for (const { id, provider } of accounts) {
    if (provider !== 'gmail') {
      if (!warned.has(id)) log('unsupported mail provider, skipped', { account: id, provider });
      warned.add(id);
      continue;
    }
    if (Date.now() - (lastPoll.get(id) ?? 0) < pollSeconds * 1000) continue;
    lastPoll.set(id, Date.now());
    const gmail = gmailFor(id);
    if (!gmail.authorized) {
      if (!warned.has(id)) log('not authorised yet, waiting', { account: id });
      warned.add(id);
      continue;
    }
    warned.delete(id);
    try {
      await pollAccount(id);
    } catch (error) {
      log('poll failed', { account: id, err: String(error.message ?? error).slice(0, 300) });
    }
  }
  setTimeout(tick, COMMAND_MS);
}
log('mail watcher started', { agent: mailAgent(), accounts: settings().accounts.map((m) => m.id) });
tick();
