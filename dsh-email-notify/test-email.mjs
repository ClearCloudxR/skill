/**
 * Standalone SMTP tool for dsh-email-notify — verify the mail path without
 * restarting DSH.
 *
 *   node test-email.mjs probe
 *       Connect, EHLO and (for 587) STARTTLS; no credentials needed.
 *
 *   node test-email.mjs send
 *       Send a real test mail to `to` using credentials from ./smtp.local.json
 *       or the DSH_SMTP_USER / DSH_SMTP_PASS / DSH_SMTP_TO environment variables.
 *       Flags: --user <addr> --pass <authcode> --to <addr> --host <host> --port <n>
 *
 *   node test-email.mjs compose
 *       Print the two mail bodies the plugin composes, without any network.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { probe, sendMailWithRetry, buildMessage } from './smtp.js';
import { buildIdleMail, buildQuestionMail, scanSession } from './index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(here, 'smtp.local.json');

/** Read CLI flags as `--key value` pairs. */
function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    out[key] = next && !next.startsWith('--') ? (i += 1, next) : true;
  }
  return out;
}

/** Merge file, environment and CLI settings; CLI wins. */
async function resolveSettings(cli) {
  let file = {};
  try {
    // PowerShell's Set-Content may write a UTF-8 BOM; tolerate it.
    const text = (await readFile(CONFIG_FILE, 'utf8')).replace(/^\uFEFF/, '');
    file = JSON.parse(text);
  } catch {
    /* optional */
  }
  return {
    host: cli.host ?? file.host ?? process.env.DSH_SMTP_HOST ?? 'smtp.qq.com',
    port: Number(cli.port ?? file.port ?? process.env.DSH_SMTP_PORT ?? 465),
    user: cli.user ?? file.user ?? process.env.DSH_SMTP_USER ?? '',
    pass: cli.pass ?? file.pass ?? process.env.DSH_SMTP_PASS ?? '',
    to: cli.to ?? file.to ?? process.env.DSH_SMTP_TO ?? 'you@example.com',
    allowInvalidCert: cli['allow-invalid-cert'] === true || file.allowInvalidCert === true,
  };
}

const [command = 'probe', ...rest] = process.argv.slice(2);
const cli = flags(rest);
const settings = await resolveSettings(cli);

if (command === 'probe') {
  console.log(`probing ${settings.host}:${settings.port} …`);
  try {
    const result = await probe({
      host: settings.host,
      port: settings.port,
      secure: settings.port === 465,
      allowInvalidCert: settings.allowInvalidCert,
    });
    console.log(`OK  greeting: ${result.greeting}`);
    console.log(`    capabilities: ${result.capabilities.join(', ')}`);
  } catch (error) {
    console.error(`FAILED  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
} else if (command === 'send') {
  const missing = [];
  if (!settings.user) missing.push('--user (发件邮箱)');
  if (!settings.pass) missing.push('--pass (SMTP 授权码)');
  if (!settings.to) missing.push('--to (收件邮箱)');
  if (missing.length > 0) {
    console.error(`missing: ${missing.join(', ')}\n`);
    console.error('把凭据写进 smtp.local.json：');
    console.error(JSON.stringify({ host: 'smtp.qq.com', port: 465, user: 'you@qq.com', pass: '授权码', to: 'you@example.com' }, null, 2));
    process.exitCode = 2;
  } else {
    const now = Date.now();
    const text = [
      'DSH 邮件提醒插件测试',
      '',
      `时间:   ${new Date(now).toLocaleString('zh-CN')}`,
      `主机:   ${settings.host}:${settings.port}`,
      `发件:   ${settings.user}`,
      '',
      '如果你收到这封邮件，说明 SMTP 通道和插件配置都是通的。',
      '接下来 DSH 任务跑完、或需要你回复时，就会自动发信到这个邮箱。',
      '',
      '—— 由 DSH 邮件提醒插件发送',
    ].join('\n');
    console.log(`sending test mail ${settings.user} -> ${settings.to} via ${settings.host}:${settings.port} …`);
    try {
      const transcript = await sendMailWithRetry({
        host: settings.host,
        port: settings.port,
        secure: settings.port === 465,
        user: settings.user,
        pass: settings.pass,
        from: settings.user,
        to: settings.to,
        subject: '[DSH] 邮件提醒测试',
        text,
        allowInvalidCert: settings.allowInvalidCert,
      }, 2);
      console.log('OK  accepted by the server:');
      for (const line of transcript) console.log(`    ${line}`);
      console.log(`\n请检查 ${settings.to} 的收件箱（也可能在垃圾邮件里）。`);
      console.log('\n预览（实际发出的正文）:');
      console.log('-'.repeat(60));
      console.log(text);
    } catch (error) {
      console.error(`FAILED  ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
} else if (command === 'compose') {
  const events = [
    { type: 'turn/start', time: Date.now() - 151_000, data: { turn: 1 } },
    { type: 'user/message', time: Date.now() - 150_000, data: { role: 'user', content: [{ type: 'text', text: '把综评数据整理成 Excel' }], source: { kind: 'user', rpcId: 'r1' } } },
    { type: 'assistant/message', time: Date.now() - 1_000, data: { message: { role: 'assistant', content: [{ type: 'text', text: '已完成，共 3 个工作表。' }] } } },
  ];
  const session = { header: { id: 'session-demo', cwd: process.cwd() }, seq: events.length, eventAt: (index) => events[index] };
  const agent = { status: 'idle', session };
  const scan = scanSession(session);
  const idle = buildIdleMail({ agent, scan });
  const question = buildQuestionMail({
    agent,
    questions: [{ id: 'q1', header: '确认', question: '要覆盖原文件吗？', options: [{ label: '覆盖' }, { label: '另存为副本' }] }],
  });
  for (const mail of [idle, question]) {
    console.log('-'.repeat(60));
    console.log(`Subject: [DSH] ${mail.subject}`);
    console.log(buildMessage({ from: 'you@qq.com', to: settings.to, subject: mail.subject, text: mail.text }).split('\r\n\r\n')[0]);
    console.log('-'.repeat(60));
    console.log(mail.text);
    console.log();
  }
} else {
  console.error(`unknown command "${command}" — use probe | send | compose`);
  process.exitCode = 2;
}
