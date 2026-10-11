/**
 * Self-test for the receive side of dsh-email-notify.
 *
 *   node test-mail.mjs          offline unit tests (no network), exit 0/1
 *   node test-mail.mjs --live   read-only probe against the real mailbox
 *
 * The live run never deletes, flags or sends anything: it uses EXAMINE plus
 * BODY.PEEK[] with markSeen disabled, so no message changes state.
 */
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fetchNewMessages, probeImap } from './imap.js';
import { htmlToText, parseMessage, stripQuoted } from './mime.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Live test credentials come from ./smtp.local.json or the DSH_SMTP_USER /
// DSH_SMTP_PASS environment variables — never from this file. The live run is
// read-only: it never marks, moves, deletes or sends anything.
async function liveConfig() {
  let file = {};
  try {
    const text = (await readFile(path.join(HERE, 'smtp.local.json'), 'utf8')).replace(/^\uFEFF/, '');
    file = JSON.parse(text);
  } catch {
    /* fall back to the environment */
  }
  const user = file.user ?? process.env.DSH_SMTP_USER ?? '';
  const pass = file.pass ?? process.env.DSH_SMTP_PASS ?? '';
  if (!user || !pass) return null;
  return {
    host: file.imapHost ?? 'imap.qq.com',
    port: Number(file.imapPort ?? 993),
    secure: true,
    user,
    pass,
    mailbox: file.mailbox ?? 'INBOX',
    timeoutMs: 45000,
  };
}

const CRLF = '\r\n';
let passed = 0;
const failures = [];

/** Assert one condition, recording the failure instead of throwing. */
function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${label}`);
    return;
  }
  const message = detail === undefined ? label : `${label} — ${detail}`;
  failures.push(message);
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`);
}

/** Assert strict equality with a readable diff. */
function checkEqual(label, actual, expected) {
  check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** Assert a substring is present. */
function checkIncludes(label, haystack, needle) {
  check(label, String(haystack).includes(needle), `${JSON.stringify(needle)} not found in ${JSON.stringify(String(haystack).slice(0, 160))}`);
}

/** Fold a header value onto continuation lines the way real mail does. */
function fold(name, value, width = 76) {
  const words = String(value).split(' ');
  const lines = [`${name}:`];
  let current = '';
  for (const word of words) {
    if (current.length > 0 && current.length + word.length + 1 > width) {
      lines.push(current);
      current = '';
    }
    current += (current.length > 0 ? ' ' : (lines.length === 1 ? ' ' : '\t')) + word;
  }
  lines.push(current);
  return lines.join(CRLF);
}

/** Encode a UTF-8 string as an RFC 2047 B-encoded word. */
function encodeB(value) {
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** Encode a UTF-8 string as an RFC 2047 Q-encoded word (byte-wise). */
function encodeQ(value) {
  const bytes = Buffer.from(value, 'utf8');
  let out = '';
  for (const byte of bytes) {
    if (byte === 0x20) out += '_';
    else if ((byte >= 0x21 && byte <= 0x7e) && !'=?_'.includes(String.fromCharCode(byte))) out += String.fromCharCode(byte);
    else out += `=${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return `=?UTF-8?Q?${out}?=`;
}

/** Base64 with the 76-column wrapping a real MTA produces. */
function wrap76(value) {
  const lines = [];
  for (let index = 0; index < value.length; index += 76) lines.push(value.slice(index, index + 76));
  return lines.join(CRLF);
}

/** Assemble a message from raw header lines plus an already encoded body. */
function fixture(headerLines, body) {
  return [...headerLines, '', ...body].join(CRLF);
}

/** Byte-exact GBK encoding of a string via an explicit lookup table. */
function gbkBytes(char) {
  if (char.charCodeAt(0) < 0x80) return [char.charCodeAt(0)];
  const table = { 中: [0xd6, 0xd0], 文: [0xce, 0xc4], 测: [0xb2, 0xe2], 试: [0xca, 0xd4] };
  return table[char] ?? [0x3f];
}

/** Build a raw GBK byte string from mixed ASCII + listed Chinese characters. */
function gbkString(text) {
  const bytes = [];
  for (const char of text) bytes.push(...gbkBytes(char));
  return Buffer.from(bytes).toString('latin1');
}

console.log('mime.js — offline unit tests');

// --- 1. plain UTF-8 text ----------------------------------------------------
const plainRaw = fixture([
  'From: Alice <alice@example.com>',
  'To: bob@example.com',
  'Subject: Plain hello',
  'Date: Mon, 01 Jan 2024 10:00:00 +0800',
  'Message-ID: <plain-1@example.com>',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=UTF-8',
], ['Hello world', 'Second line', '', 'After a blank line']);
{
  const mail = parseMessage(plainRaw);
  checkEqual('plain: subject', mail.subject, 'Plain hello');
  checkEqual('plain: fromAddress', mail.fromAddress, 'alice@example.com');
  checkEqual('plain: from', mail.from, 'Alice <alice@example.com>');
  checkEqual('plain: messageId', mail.messageId, 'plain-1@example.com');
  checkEqual('plain: headers are lowercase', mail.headers['content-type'], 'text/plain; charset=UTF-8');
  checkEqual('plain: hadHtml', mail.hadHtml, false);
  checkIncludes('plain: body keeps blank line', mail.text, 'Second line\n\nAfter a blank line');
  checkEqual('plain: date', mail.date, 'Mon, 01 Jan 2024 10:00:00 +0800');
}

// --- 2. base64 UTF-8 body ---------------------------------------------------
const base64Body = '这是 base64 编码的中文正文。\n第二行。';
const base64Raw = fixture([
  'From: =?UTF-8?B?5byg5LiJ?= <zhang@example.com>',
  'Subject: base64 body',
  'Content-Type: text/plain; charset=UTF-8',
  'Content-Transfer-Encoding: base64',
], wrap76(Buffer.from(base64Body, 'utf8').toString('base64')).split(CRLF));
{
  const mail = parseMessage(base64Raw);
  checkEqual('base64: from address', mail.fromAddress, 'zhang@example.com');
  checkEqual('base64: from display name', mail.from, '张三 <zhang@example.com>');
  checkEqual('base64: text', mail.text, base64Body);
}

// --- 3. quoted-printable UTF-8 body -----------------------------------------
const qpRaw = fixture([
  'From: Bob <bob@example.com>',
  'Subject: qp body',
  'Content-Type: text/plain; charset=UTF-8',
  'Content-Transfer-Encoding: quoted-printable',
], [
  '第一行中文=EF=BC=8Csoft break follows=',
  'and continues here.',
  'Soft line after=',
  'still same paragraph.',
]);
{
  const mail = parseMessage(qpRaw);
  checkEqual('qp: soft break joins lines', mail.text.split('\n')[0], '第一行中文，soft break followsand continues here.');
  checkIncludes('qp: second paragraph', mail.text, 'still same paragraph.');
}

// --- 4. GBK charset body ----------------------------------------------------
// The raw source is built byte-by-byte in latin1 so the GBK bytes survive; the
// parser must then decode them as gb2312/gb18030.
const gbkRaw = fixture([
  'From: =?gb2312?B?1tDOxA==?= <gbk@example.com>',
  'Subject: =?gbk?B?1tDOxLLiytQ=?=',
  'Content-Type: text/plain; charset=gb2312',
  'Content-Transfer-Encoding: 8bit',
], [gbkString('中文测试 done'), 'end']);
{
  const mail = parseMessage(Buffer.from(gbkRaw, 'latin1'));
  checkEqual('gbk: subject decoded', mail.subject, '中文测试');
  checkEqual('gbk: from display name', mail.from, '中文 <gbk@example.com>');
  checkEqual('gbk: body decoded', mail.text, '中文测试 done\nend');
}

// --- 5. multipart/alternative (plain + html) --------------------------------
const altPlain = '这是纯文本版本。\n第二段。';
const altRaw = fixture([
  'From: Carol <carol@example.com>',
  'Subject: multipart alternative',
  'MIME-Version: 1.0',
  'Content-Type: multipart/alternative; boundary="BOUND-1"',
], [
  'preamble ignored',
  '--BOUND-1',
  'Content-Type: text/plain; charset=UTF-8',
  'Content-Transfer-Encoding: base64',
  '',
  wrap76(Buffer.from(altPlain, 'utf8').toString('base64')),
  '--BOUND-1',
  'Content-Type: text/html; charset=UTF-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  '<html><body><p>HTML =E7=89=88=E6=9C=AC</p><p>Second</p></body></html>',
  '--BOUND-1--',
  'epilogue ignored',
]);
{
  const mail = parseMessage(altRaw);
  checkEqual('multipart: plain preferred', mail.text, altPlain);
  checkEqual('multipart: hadHtml', mail.hadHtml, true);
  checkEqual('multipart: no boundary leakage', mail.text.includes('--BOUND-1'), false);
  checkEqual('multipart: no html tags', mail.text.includes('<p>'), false);
}

// --- 6. html-only message ---------------------------------------------------
const htmlOnlyRaw = fixture([
  'From: Dave <dave@example.com>',
  'Subject: html only',
  'Content-Type: text/html; charset=UTF-8',
], ['<div>Hello&nbsp;<b>世界</b></div><div>Line two</div><script>bad()</script>']);
{
  const mail = parseMessage(htmlOnlyRaw);
  checkEqual('html-only: hadHtml', mail.hadHtml, true);
  checkIncludes('html-only: entity decoded', mail.text, 'Hello 世界');
  checkIncludes('html-only: line break', mail.text, 'Line two');
  checkEqual('html-only: script removed', mail.text.includes('bad()'), false);
  checkEqual('html-only: tags removed', mail.text.includes('<b>'), false);
}

// --- 7. RFC 2047 subject with several encoded words -------------------------
const multiWordSubject = `${encodeB('【通知】')} ${encodeQ('任务 完成')} ${encodeB('✅')}`;
const wordsRaw = fixture([
  'From: Eve <eve@example.com>',
  `Subject: ${multiWordSubject}`,
  'Content-Type: text/plain; charset=UTF-8',
], ['body']);
{
  const mail = parseMessage(wordsRaw);
  // RFC 2047: whitespace between adjacent encoded-words is dropped, while a
  // space encoded inside a word (Q `_` / `=20`) is content and survives.
  checkEqual('rfc2047: mixed B and Q words', mail.subject, '【通知】任务 完成✅');
  checkEqual('rfc2047: adjacent words drop separator',
    parseMessage(`Subject: ${encodeB('你好')} ${encodeB('世界')}\n\nx`).subject, '你好世界');
  checkEqual('rfc2047: separator dropped across charsets',
    parseMessage('Subject: =?UTF-8?B?5L2g5aW9?= =?gbk?B?1tDOxLLiytQ=?=\n\nx').subject, '你好中文测试');
  checkEqual('rfc2047: encoded inner space kept',
    parseMessage(`Subject: ${encodeQ('任务 完成')}\n\nx`).subject, '任务 完成');
}

// --- 8. folded headers ------------------------------------------------------
const foldedRaw = fixture([
  'From: Frank <frank@example.com>',
  fold('Subject', `=?UTF-8?B?${Buffer.from('一个很长的中文主题需要折行', 'utf8').toString('base64')}?= tail`),
  'Content-Type: text/plain; charset=UTF-8',
], ['body']);
{
  const mail = parseMessage(foldedRaw);
  checkEqual('folded: unfolded before decoding', mail.subject, '一个很长的中文主题需要折行 tail');
  checkEqual('folded: no CRLF in header value', mail.headers.subject.includes('\r'), false);
}

// --- 9. reply headers and quoted text ---------------------------------------
const replyRaw = fixture([
  'From: Grace <grace@example.com>',
  'Subject: Re: 你好',
  'In-Reply-To: <parent-1@example.com>',
  'References: <root-0@example.com> <parent-1@example.com>',
  'Auto-Submitted: auto-replied',
  'Content-Type: text/plain; charset=UTF-8',
], [
  '我的新回复。',
  '',
  '在 2024年1月1日 10:00, Alice 写道：',
  '> 这是被引用的原文。',
  '> 第二行引用。',
]);
{
  const mail = parseMessage(replyRaw);
  checkEqual('reply: inReplyTo', mail.inReplyTo, 'parent-1@example.com');
  checkEqual('reply: references count', mail.references.length, 2);
  checkEqual('reply: references first', mail.references[0], 'root-0@example.com');
  checkEqual('reply: autoSubmitted raw value', mail.autoSubmitted, 'auto-replied');
  checkEqual('stripQuoted: attribution cut', stripQuoted(mail.text), '我的新回复。');
}
checkEqual('stripQuoted: gt lines removed', stripQuoted('a\n> b\n> c\nd'), 'a\nd');
checkEqual('stripQuoted: english attribution', stripQuoted('answer\n\nOn Mon, Jan 1 2024 Alice wrote:\n> old'), 'answer');

// Real-world case: the reply body starts with new content, then a Chinese
// attribution line, then the quoted lines. Only the new content must survive.
{
  const body = [
    '这是我的新要求',
    '',
    '在 2026-10-11，DSH 写道：',
    '> 之前的内容',
    '> 更多引用',
  ].join('\n');
  const stripped = stripQuoted(body);
  checkEqual('stripQuoted: content before a Chinese attribution', stripped, '这是我的新要求');
  check('stripQuoted: quoted body removed', !stripped.includes('之前的内容')
    && !stripped.includes('更多引用') && !stripped.includes('写道'), JSON.stringify(stripped));
}

// --- 10. malformed input must never throw -----------------------------------
{
  let threw = null;
  let mail = null;
  try {
    mail = parseMessage(Buffer.from([0x00, 0xff, 0xfe, 0x0d, 0x0a, 0x0d, 0x0a, 0xc3, 0x28]));
  } catch (error) {
    threw = error;
  }
  check('malformed: binary input does not throw', threw === null, threw?.message);
  check('malformed: returns partial object', mail !== null && typeof mail.text === 'string');
  check('malformed: missing headers default to empty', mail.subject === '' && mail.fromAddress === '');

  let threw2 = null;
  try {
    parseMessage('');
    parseMessage('no header body at all');
    parseMessage('Content-Type: multipart/mixed; boundary=missing' + CRLF + CRLF + 'nothing here');
    htmlToText('<p>unclosed');
    stripQuoted('');
  } catch (error) {
    threw2 = error;
  }
  check('malformed: edge inputs do not throw', threw2 === null, threw2?.message);
}

// --- 11. htmlToText details -------------------------------------------------
{
  const text = htmlToText('<p>a</p><p>b</p><br>c');
  checkIncludes('htmlToText: paragraphs separated', text, 'a\n\nb');
  checkIncludes('htmlToText: br becomes newline', text, '\nc');
  checkEqual('htmlToText: numeric entity', htmlToText('&#20013;&#x6587;'), '中文');
  checkEqual('htmlToText: nbsp collapsed', htmlToText('a&nbsp;&nbsp;b'), 'a b');
}

// --- 12. zero third-party imports -------------------------------------------
{
  const files = ['imap.js', 'mime.js'];
  const thirdParty = [];
  for (const file of files) {
    let source = '';
    try {
      source = readFileSync(path.join(HERE, file), 'utf8');
    } catch (error) {
      check(`imports: ${file} is readable`, false, error.message);
      continue;
    }
    const specifiers = [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
    for (const specifier of specifiers) {
      const allowed = specifier.startsWith('node:') || specifier.startsWith('./') || specifier.startsWith('../');
      if (!allowed) thirdParty.push(`${file}: ${specifier}`);
    }
    check(`imports: ${file} uses only node:/relative modules`,
      specifiers.every((s) => s.startsWith('node:') || s.startsWith('./') || s.startsWith('../')),
      specifiers.join(', '));
  }
  check('imports: no third-party dependency anywhere', thirdParty.length === 0, thirdParty.join(', '));
}

// --- 13. exported API surface ------------------------------------------------
{
  const imap = await import('./imap.js');
  const mime = await import('./mime.js');
  check('imap.js exports fetchNewMessages', typeof imap.fetchNewMessages === 'function');
  check('imap.js exports probeImap', typeof imap.probeImap === 'function');
  check('imap.js exports pickFetchResponse', typeof imap.pickFetchResponse === 'function');
  check('mime.js exports parseMessage', typeof mime.parseMessage === 'function');
  check('mime.js exports stripQuoted', typeof mime.stripQuoted === 'function');
  check('mime.js exports htmlToText', typeof mime.htmlToText === 'function');
}

// --- 14. UID FETCH response selection ----------------------------------------
// Regression guard: the tagged completion line 'a5 OK Fetch completed' must not
// be mistaken for the message. Only the untagged '* N FETCH' line carries the
// BODY[] literal, and the raw body must come back non-empty.
{
  const { pickFetchResponse } = await import('./imap.js');
  const literal = Buffer.from('Subject: picked\r\n\r\nbody bytes', 'utf8');
  const responses = [
    { tag: '*', untagged: true, status: null, segments: ['* 1 FETCH (UID 616 FLAGS () BODY[] {32}', literal, ')'], text: '' },
    { tag: 'a5', untagged: false, status: 'OK', segments: ['a5 OK Fetch completed'], text: 'a5 OK Fetch completed' },
  ];
  const picked = pickFetchResponse(responses);
  check('pickFetchResponse: picks the literal-bearing response', picked === responses[0],
    `picked tag ${picked?.tag}`);
  check('pickFetchResponse: selected response holds the bytes',
    picked.segments.some((part) => Buffer.isBuffer(part)));

  // Fallback behaviour when a server answers without any literal at all.
  const empty = pickFetchResponse([{ segments: ['a5 OK done'], text: 'a5 OK done' }]);
  check('pickFetchResponse: falls back to the last response', empty.segments[0] === 'a5 OK done');
  check('pickFetchResponse: tolerates an empty list', pickFetchResponse([]).segments.length === 0);
}

console.log(`\n${passed} checks passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log('failures:');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
}

if (process.argv.includes('--live')) {
  console.log('\n=== live IMAP test (read-only) ===');
  // Live failures must fail the run, not just print, so a broken fetch cannot
  // slip through again.
  const liveFailures = [];
  const assertLive = (label, condition, detail) => {
    if (condition) {
      passed += 1;
      console.log(`  ok   ${label}`);
      return;
    }
    liveFailures.push(label);
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  };

  const live = await liveConfig();
  if (!live) {
    console.log('  skip: no credentials (create smtp.local.json or set DSH_SMTP_USER/DSH_SMTP_PASS)');
  } else {
  const config = { ...live, readOnly: true };
  const status = await probeImap(config);
  console.log(`greeting    : ${status.greeting}`);
  console.log(`mailbox     : ${status.mailbox}`);
  console.log(`exists      : ${status.exists}`);
  console.log(`unseen      : ${status.unseen}`);
  console.log(`uidNext     : ${status.uidNext}`);
  console.log(`capabilities: ${status.capabilities.join(' ')}`);
  assertLive('live: probe reports a mailbox', status.exists > 0, `exists=${status.exists}`);
  assertLive('live: probe reports uidNext', status.uidNext > 0, `uidNext=${status.uidNext}`);

  const poll = await fetchNewMessages(config, { readOnly: true, markSeen: false, limit: 5 });
  console.log(`\nfetched ${poll.messages.length} message(s), uidValidity=${poll.uidValidity}, uidNext=${poll.uidNext}`);
  console.log(`flagged as seen: ${poll.seen.length === 0 ? 'none (as required)' : poll.seen.join(',')}`);
  assertLive('live: read-only run marks nothing as seen', poll.seen.length === 0, poll.seen.join(','));
  assertLive('live: fetched at least one message', poll.messages.length > 0);
  assertLive('live: uidValidity is reported', poll.uidValidity.length > 0, poll.uidValidity);

  // The download must not have turned any unread mail into read mail: the
  // unread count reported by the server has to be identical afterwards.
  const after = await probeImap(config);
  console.log(`unseen before ${status.unseen} → after ${after.unseen}`);
  assertLive('live: unread count unchanged after reading',
    after.unseen === status.unseen, `${status.unseen} -> ${after.unseen}`);
  assertLive('live: EXISTS unchanged after reading',
    after.exists === status.exists, `${status.exists} -> ${after.exists}`);

  let parsedOk = 0;
  for (const message of poll.messages) {
    const mail = parseMessage(message.raw);
    const preview = mail.text.replace(/\s+/g, ' ').slice(0, 200);
    console.log(`\n--- uid ${message.uid} (${message.raw.length} bytes, flags: ${message.flags.join(' ') || 'none'})`);
    console.log(`from    : ${mail.from} <${mail.fromAddress}>`);
    console.log(`subject : ${mail.subject}`);
    console.log(`date    : ${mail.date}`);
    console.log(`preview : ${preview}`);
    assertLive(`live: uid ${message.uid} raw body is non-empty`, message.raw.length > 0, `${message.raw.length} bytes`);
    assertLive(`live: uid ${message.uid} has from or subject`,
      mail.from.length > 0 || mail.subject.length > 0,
      `from=${JSON.stringify(mail.from)} subject=${JSON.stringify(mail.subject)}`);
    if (message.raw.length > 0 && (mail.from.length > 0 || mail.subject.length > 0)) parsedOk += 1;
  }
  assertLive('live: every fetched message parsed into headers', parsedOk === poll.messages.length,
    `${parsedOk}/${poll.messages.length}`);

  if (liveFailures.length > 0) {
    console.log(`\nlive: ${passed} checks passed, ${liveFailures.length} failed`);
    for (const failure of liveFailures) console.log(`  - ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(`\nlive: all ${passed} checks passed`);
  }
  }
}
