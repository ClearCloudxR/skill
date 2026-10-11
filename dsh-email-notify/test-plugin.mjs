/**
 * Offline harness for the plugin: drives the Cordis listeners with a fake
 * context and a fake Session, and prints the composed mails. No network.
 *
 *   node test-plugin.mjs
 */
import { apply, buildIdleMail, buildQuestionMail, normalizeConfig, scanSession } from './index.js';

const hr = (title) => console.log(`\n${'='.repeat(64)}\n${title}\n${'='.repeat(64)}`);

class FakeCtx {
  constructor() {
    this.handlers = new Map();
    this.logs = [];
    this.disposers = [];
    this.logger = {
      info: (message) => this.logs.push(['info', String(message)]),
      warn: (message) => this.logs.push(['warn', String(message)]),
    };
  }

  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push(fn);
    return () => {};
  }

  effect(fn) {
    const disposer = fn();
    if (typeof disposer === 'function') this.disposers.push(disposer);
    return disposer;
  }

  emit(event, payload) {
    for (const fn of this.handlers.get(event) ?? []) {
      const result = fn(payload, () => Promise.resolve());
      if (result && typeof result.then === 'function') result.catch(() => {});
    }
  }

  async waterfall(event, payload) {
    const chain = [...(this.handlers.get(event) ?? [])];
    const dispatch = (index) => {
      const fn = chain[index];
      if (!fn) return Promise.resolve('unavailable');
      return fn(payload, () => dispatch(index + 1));
    };
    return await dispatch(0);
  }
}

const EVENT_TIME = 1_760_000_000_000;

/** A fake session whose log tail looks like a finished DSH turn. */
function fakeSession({ subagent = false } = {}) {
  const events = [
    { type: 'session/start', time: EVENT_TIME - 200_000, data: {} },
    { type: 'turn/start', time: EVENT_TIME - 151_000, data: { turn: 3 } },
    {
      type: 'user/message',
      time: EVENT_TIME - 150_000,
      data: {
        role: 'user',
        content: [{ type: 'text', text: '把 591iq 的综评数据整理成 Excel 并汇总' }],
        source: { kind: 'user', rpcId: 'rpc-1' },
      },
    },
    {
      type: 'user/message',
      time: EVENT_TIME - 100_000,
      data: { role: 'user', content: [{ type: 'text', text: 'time context injection' }], source: { kind: 'time-context' } },
    },
    {
      type: 'assistant/message',
      time: EVENT_TIME - 2_000,
      data: {
        role: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: '## 整理结果\n\n已经**整理完成**，共 3 个工作表：' },
            { type: 'text', text: '1. `综评全量`（418 行）\n2. [活动总结清单](https://example.com/sheet)（27 行）\n\n| 表名 | 行数 |\n| --- | --- |\n| 综评全量 | 418 |\n\n- 缺失项检查：0 行\n\n```python\nprint("hello")\n```' },
          ],
        },
      },
    },
    { type: 'turn/end', time: EVENT_TIME - 1_000, data: { turn: 3, reason: { kind: 'completed' } } },
  ];
  return {
    header: { id: 'session-00000000-test', cwd: 'E:\\文档\\deepseek-harness\\default-workspace', ...(subagent ? { origin: 'subagent' } : {}) },
    seq: events.length,
    eventAt: (index) => events[index],
  };
}

const agent = { status: 'idle', session: fakeSession() };
const subagent = { status: 'idle', session: fakeSession({ subagent: true }) };
const seen = [];
const ctx = new FakeCtx();
apply(ctx, {
  to: 'you@example.com',
  smtp: { host: 'smtp.qq.com', port: 465, user: 'someone@qq.com', pass: 'placeholder' },
  dryRun: true,
  logMail: true,
  idleDelayMs: 0,
});

const mails = () => ctx.logs.map(([, message]) => message).filter((message) => message.includes('To: you@example.com'));

hr('1. scanSession over the fake log');
console.log(scanSession(agent.session));

hr('2. buildIdleMail (direct)');
console.log(buildIdleMail({ agent, scan: scanSession(agent.session) }).text);

hr('3. plugin: agent/status -> idle (subagent first, then root)');
ctx.emit('agent/status', { agent: subagent, status: 'idle' });
ctx.emit('agent/status', { agent, status: 'running' });
ctx.emit('agent/status', { agent, status: 'idle' });
await new Promise((resolve) => setTimeout(resolve, 50));
console.log(`mails composed: ${mails().length}`);
console.log(mails().at(-1));

hr('4. plugin: same idle repeated -> no duplicate mail');
ctx.emit('agent/status', { agent, status: 'idle' });
await new Promise((resolve) => setTimeout(resolve, 50));
console.log(`mails composed: ${mails().length} (expected 1)`);

hr('5. plugin: agent/error then a new turn -> failure mail');
const agent2 = { status: 'idle', session: fakeSession() };
ctx.emit('agent/error', { agent: agent2, error: new Error('llm request failed: ECONNRESET') });
ctx.emit('agent/status', { agent: agent2, status: 'running' });
ctx.emit('agent/status', { agent: agent2, status: 'idle' });
await new Promise((resolve) => setTimeout(resolve, 50));
console.log(mails().at(-1));

hr('6. plugin: user-questions/request -> answer mail, through the waterfall');
const reply = await ctx.waterfall('user-questions/request', {
  agent,
  signal: new AbortController().signal,
  questions: [
    {
      id: 'q1',
      header: '确认',
      question: '要覆盖原来的 591iq_黄浩格_综评全量.xlsx 吗？',
      options: [
        { label: '覆盖', description: '直接写入原文件' },
        { label: '另存为副本', description: '保留原文件' },
      ],
      multiSelect: false,
    },
  ],
}, () => Promise.resolve('answered'));
await new Promise((resolve) => setTimeout(resolve, 50));
console.log(`waterfall result: ${reply}`);
console.log(mails().at(-1));

hr('7. normalizeConfig: defaults + passEnv');
process.env.DSH_SMTP_PASS = 'from-env';
console.log(normalizeConfig({ to: 'a@b.c', smtp: { user: 'u@qq.com', passEnv: 'DSH_SMTP_PASS' } }));

hr('8. warning path: not configured');
const bare = new FakeCtx();
apply(bare, {});
console.log(bare.logs);

const failures = [];
if (mails().length !== 3) failures.push(`expected 3 mails total, composed ${mails().length}`);
if (!mails().some((mail) => mail.includes('任务完成'))) failures.push('task-finished mail missing');
if (!mails().some((mail) => mail.includes('需要你回复'))) failures.push('question mail missing');
if (!mails().some((mail) => mail.includes('任务出错'))) failures.push('failure mail missing');
const warnings = ctx.logs.filter(([level]) => level === 'warn');
if (warnings.length > 0) failures.push(`unexpected warnings: ${warnings.map(([, message]) => message).join(' | ')}`);
if (!/not configured yet/.test(bare.logs[0]?.[1] ?? '')) failures.push('unconfigured plugin should warn about missing settings');

// The mail body must read as plain text: no leftover Markdown markers.
for (const mail of mails()) {
  const body = mail.split('\n').filter((line) => !line.startsWith('To: ') && !line.startsWith('Subject: ')).join('\n');
  for (const marker of ['**', '##', '```', '](http', '| ---']) {
    if (body.includes(marker)) failures.push(`mail body still contains Markdown "${marker}"`);
  }
}
if (!mails().some((mail) => mail.includes('整理结果') && mail.includes('活动总结清单 (https://example.com/sheet)'))) {
  failures.push('markdown link/heading were not converted to plain text');
}

hr('RESULT');
if (failures.length > 0) {
  console.log(`FAILED:\n- ${failures.join('\n- ')}`);
  process.exitCode = 1;
} else {
  console.log('all checks passed');
}
