/**
 * Tests for the inbound side.
 *
 *   node test-inbound.mjs           offline: classification rules only
 *   node test-inbound.mjs --live    also read the real mailbox (read-only) and
 *                                   show what the plugin would do with each mail
 *
 * Live mode reads credentials from ./smtp.local.json or DSH_SMTP_USER /
 * DSH_SMTP_PASS. It never changes a flag, never deletes, never sends.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { classifyMail, normalizeSubject } from './inbound.js';
import { parseMessage } from './mime.js';
import { probeImap, fetchNewMessages } from './imap.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const failures = [];
let checks = 0;

function check(name, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures.push(name);
  }
}

/**
 * Build one raw RFC822 message for a fixture. A non-ASCII subject is emitted
 * the way real mail does it (RFC 2047), because a raw UTF-8 header is
 * non-conformant and parsers may legitimately read it as latin-1.
 */
function raw({ from = 'you@example.com', subject = '测试', body = '你好', headers = [] } = {}) {
  const subjectLine = /^[\x20-\x7e]*$/.test(subject)
    ? subject
    : `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
  return [
    `From: ${from}`,
    'To: you@example.com',
    `Subject: ${subjectLine}`,
    'Message-ID: <fixture@local>',
    'Content-Type: text/plain; charset=UTF-8',
    ...headers,
    '',
    body,
  ].join('\r\n');
}

console.log('classification rules');

const allowed = new Set(['you@example.com']);

const plain = parseMessage(raw({ body: '把 Excel 再按班级拆一份' }));
check('plain mail -> new Session',
  classifyMail(plain, { allowed }).action === 'new',
  JSON.stringify(classifyMail(plain, { allowed })));

check('unknown sender -> skipped',
  classifyMail(parseMessage(raw({ from: 'news@example.com', body: '广告' })), { allowed }).action === 'skip');

check('our own notification -> skipped',
  classifyMail(parseMessage(raw({ headers: ['Auto-Submitted: auto-generated', 'X-DSH-Notify: 1'], body: '✅ 任务完成' })), { allowed }).action === 'skip');

check('Auto-Submitted alone -> skipped',
  classifyMail(parseMessage(raw({ headers: ['Auto-Submitted: auto-replied'], body: '休假自动回复' })), { allowed }).action === 'skip');

const quoted = parseMessage(raw({ body: '这是我的新要求\r\n\r\n在 2026-10-11，DSH 写道：\r\n> 之前的内容\r\n> 更多引用' }));
const quotedDecision = classifyMail(quoted, { allowed });
check('quoted reply keeps only the new text',
  quotedDecision.action === 'new'
    && quotedDecision.body.includes('这是我的新要求')
    && !quotedDecision.body.includes('之前的内容'),
  JSON.stringify(quotedDecision.body));

check('quote-only reply -> skipped',
  classifyMail(parseMessage(raw({ body: '在 2026-10-11，DSH 写道：\r\n> 只剩引用' })), { allowed }).action === 'skip');

const reply = parseMessage([raw({ body: '继续把剩下的表也做了' }).split('\r\n').slice(0, 4).join('\r\n'), 'In-Reply-To: <notify-1@dsh>', '', '继续把剩下的表也做了'].join('\r\n'));
const live = classifyMail(reply, { allowed, messageIds: { 'notify-1@dsh': 'session-abc' }, isLive: () => true });
check('reply to a live Session -> continue',
  live.action === 'continue' && live.sessionId === 'session-abc',
  JSON.stringify(live));

const dead = classifyMail(reply, { allowed, messageIds: { 'notify-1@dsh': 'session-abc' }, isLive: () => false });
check('reply to a dead Session -> new Session',
  dead.action === 'new' && /not running/.test(dead.reason ?? ''),
  JSON.stringify(dead));

const threaded = parseMessage([raw().split('\r\n').slice(0, 4).join('\r\n'), 'References: <other@x> <notify-1@dsh>', '', '顺着 References 也要能接上'].join('\r\n'));
check('References chain is honoured',
  classifyMail(threaded, { allowed, messageIds: { 'notify-1@dsh': 'session-abc' }, isLive: () => true }).action === 'continue');

// A phone mail client that drops In-Reply-To must still continue the Session.
const subjectKey = normalizeSubject('[DSH] ✅ 任务完成 · 整理数据');
check('normalizeSubject strips reply prefixes',
  normalizeSubject('Re: [DSH] ✅ 任务完成 · 整理数据') === subjectKey
    && normalizeSubject('回复：[DSH] ✅ 任务完成 · 整理数据') === subjectKey
    && normalizeSubject('RE:RE:[DSH] ✅ 任务完成 · 整理数据') === subjectKey,
  JSON.stringify([normalizeSubject('Re: [DSH] ✅ 任务完成 · 整理数据'), subjectKey]));

const noHeaders = parseMessage(raw({ subject: 'Re:[DSH] ✅ 任务完成 · 整理数据', body: '把剩下的表也做了' }));
const bySubject = classifyMail(noHeaders, { allowed, subjects: { [subjectKey]: 'session-abc' }, isLive: () => true });
check('reply without In-Reply-To still continues via subject',
  bySubject.action === 'continue' && bySubject.sessionId === 'session-abc',
  JSON.stringify(bySubject));

const deadBySubject = classifyMail(noHeaders, { allowed, subjects: { [subjectKey]: 'session-abc' }, isLive: () => false });
check('subject fallback also respects a dead Session',
  deadBySubject.action === 'new' && /not running/.test(deadBySubject.reason ?? ''),
  JSON.stringify(deadBySubject));

check('a stranger replying to the same subject is still rejected',
  classifyMail(parseMessage(raw({ from: 'someone@else.com', subject: 'Re:[DSH] ✅ 任务完成 · 整理数据', body: '你好' })),
    { allowed, subjects: { [subjectKey]: 'session-abc' }, isLive: () => true }).action === 'skip');

if (process.argv.includes('--live')) {
  console.log('\nlive mailbox (read-only)');
  let credentials = {};
  try {
    // PowerShell's Set-Content may write a UTF-8 BOM; tolerate it.
    const text = (await readFile(path.join(here, 'smtp.local.json'), 'utf8')).replace(/^\uFEFF/, '');
    credentials = JSON.parse(text);
  } catch {
    /* fall back to the environment */
  }
  const user = credentials.user ?? process.env.DSH_SMTP_USER ?? '';
  const pass = credentials.pass ?? process.env.DSH_SMTP_PASS ?? '';
  if (!user || !pass) {
    console.log('  skip: no credentials (create smtp.local.json or set DSH_SMTP_USER/DSH_SMTP_PASS)');
  } else {
    const imapConfig = { host: credentials.imapHost ?? 'imap.qq.com', port: 993, secure: true, user, pass, readOnly: true };
    try {
      const probe = await probeImap(imapConfig);
      console.log(`  mailbox ${probe.mailbox}: ${probe.exists} messages, ${probe.unseen} unseen, uidNext ${probe.uidNext}`);
      const recent = await fetchNewMessages(imapConfig, { sinceUid: Math.max(0, probe.uidNext - 4), limit: 4, markSeen: false });
      for (const message of recent.messages) {
        const mail = parseMessage(message.raw);
        const decision = classifyMail(mail, { allowed: new Set([user.toLowerCase()]) });
        console.log(`  uid ${message.uid}  from=${mail.fromAddress}  subject=${mail.subject}`);
        console.log(`      -> ${decision.action}${decision.reason ? ` (${decision.reason})` : ''}${decision.sessionId ? ` ${decision.sessionId}` : ''}`);
      }
      if (recent.messages.length === 0) console.log('  (no recent message to inspect)');
    } catch (error) {
      console.log(`  live check failed: ${error instanceof Error ? error.message : String(error)}`);
      failures.push('live mailbox check');
    }
  }
}

console.log(`\n${checks - failures.length}/${checks} checks passed`);
if (failures.length > 0) {
  console.log(`failures:\n  - ${failures.join('\n  - ')}`);
  process.exitCode = 1;
}
