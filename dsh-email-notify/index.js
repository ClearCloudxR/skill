/**
 * dsh-email-notify — mail your phone when a DSH task finishes, or when DSH
 * needs an answer from you.
 *
 * Two triggers, both read from the live Session:
 *   - `agent/status` becomes `idle`  -> "task finished" mail with the final reply
 *   - `user-questions/request`       -> "waiting for your answer" mail
 *
 * Zero runtime dependencies: the SMTP client lives in ./smtp.js.
 */
import { appendFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sendMailWithRetry, buildMessageId } from './smtp.js';
import { toPlainText } from './plaintext.js';
import { startInbound } from './inbound.js';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'email-notify';

const DEFAULT_SUBJECT_PREFIX = '[DSH]';

const DEFAULTS = {
  enabled: true,
  /** Recipient(s); comma separated. */
  to: '',
  /** Sender; defaults to the SMTP account. */
  from: '',
  subjectPrefix: DEFAULT_SUBJECT_PREFIX,
  notifyOnIdle: true,
  notifyOnQuestion: true,
  skipSubagents: true,
  /**
   * Wait this long after the agent goes idle before mailing, and skip if it
   * started running again — that keeps multi-round goals to one mail.
   */
  idleDelayMs: 8000,
  /** Do not mail for work shorter than this. */
  minDurationMs: 0,
  /** Characters of the user's task / the final reply kept in the body. */
  taskChars: 600,
  replyChars: 1500,
  /** Compose and log the mail but never open an SMTP connection. */
  dryRun: false,
  /** Append every composed mail to this file as well. */
  outboxFile: '',
  /** Log every composed mail to the DSH log. */
  logMail: false,
  smtp: {
    host: 'smtp.qq.com',
    port: 465,
    secure: true,
    user: '',
    pass: '',
    /** Read the password from this environment variable instead of `pass`. */
    passEnv: '',
    timeoutMs: 30000,
    attempts: 2,
    allowInvalidCert: false,
  },
  /**
   * Inbound side: poll the same mailbox and turn mail from the owner into DSH
   * work (reply to a notification continues that Session).
   */
  inbound: {
    enabled: false,
    host: 'imap.qq.com',
    port: 993,
    secure: true,
    user: '',
    pass: '',
    passEnv: '',
    mailbox: 'INBOX',
    pollMs: 30000,
    timeoutMs: 30000,
    /** Senders allowed to drive DSH; empty falls back to the SMTP account. */
    allowFrom: [],
    /** Workspace for Sessions started by a fresh (non-reply) mail. */
    workspacePath: '',
    agentPreset: 'standard',
    permissionPreset: 'danger-full-access',
    maxPerPoll: 5,
    replyToSession: true,
    allowInvalidCert: false,
    /** UID watermark + notification Message-ID map; empty disables persistence. */
    stateFile: '',
  },
};

/** Shallow merge with one nested level for `smtp` and `inbound`. */
export function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const smtp = { ...DEFAULTS.smtp, ...(input.smtp && typeof input.smtp === 'object' ? input.smtp : {}) };
  const inbound = { ...DEFAULTS.inbound, ...(input.inbound && typeof input.inbound === 'object' ? input.inbound : {}) };
  const config = { ...DEFAULTS, ...input, smtp, inbound };
  if (smtp.passEnv && !smtp.pass) smtp.pass = process.env[smtp.passEnv] ?? '';
  if (!config.from) config.from = smtp.user;
  // The inbound side defaults to the same mailbox and authorization code.
  if (!inbound.user) inbound.user = smtp.user;
  if (inbound.passEnv && !inbound.pass) inbound.pass = process.env[inbound.passEnv] ?? '';
  if (!inbound.pass) inbound.pass = smtp.pass;
  if (!Array.isArray(inbound.allowFrom)) inbound.allowFrom = inbound.allowFrom ? [inbound.allowFrom] : [];
  if (!inbound.stateFile) {
    inbound.stateFile = join(homedir(), '.dsh', 'storages', 'email-notify', 'inbound-state.json');
  }
  for (const key of ['idleDelayMs', 'minDurationMs', 'taskChars', 'replyChars']) {
    const value = Number(config[key]);
    config[key] = Number.isFinite(value) && value >= 0 ? value : DEFAULTS[key];
  }
  for (const key of ['pollMs', 'maxPerPoll', 'port', 'timeoutMs']) {
    const value = Number(inbound[key]);
    inbound[key] = Number.isFinite(value) && value > 0 ? value : DEFAULTS.inbound[key];
  }
  return config;
}

/** `2026-06-07 21:30:12 +08:00` in local time. */
export function formatTime(ms) {
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const offset = `${sign}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${offset}`;
}

/** `2 分 31 秒` from a millisecond count. */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '未知';
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const parts = [];
  if (hours > 0) parts.push(`${hours} 小时`);
  if (minutes > 0) parts.push(`${minutes} 分`);
  parts.push(`${seconds} 秒`);
  return parts.join(' ');
}

/** Join the text blocks of one message content array. */
export function textOfContent(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/** Truncate without cutting a surrogate pair in half. */
export function clip(text, limit) {
  const value = String(text ?? '').trim();
  if (!Number.isFinite(limit) || limit <= 0 || value.length <= limit) return value;
  return `${[...value].slice(0, limit).join('')}\n…（已截断，共 ${[...value].length} 字）`;
}

/**
 * Read the tail of one Session log: the user's task, the assistant's last
 * reply, and the timing of the newest turn.
 */
export function scanSession(session) {
  const result = {
    task: null,
    reply: null,
    turn: 0,
    turnStart: null,
    lastEventTime: null,
    interrupted: false,
  };
  if (!session || typeof session.eventAt !== 'function') return result;
  const end = Number.isSafeInteger(session.seq) ? session.seq : 0;
  for (let seq = end - 1; seq >= 0; seq -= 1) {
    let event;
    try {
      event = session.eventAt(seq);
    } catch {
      break;
    }
    if (!event || typeof event.type !== 'string') continue;
    if (result.lastEventTime === null && typeof event.time === 'number') result.lastEventTime = event.time;
    if (event.type === 'turn/start' && result.turnStart === null) {
      result.turnStart = typeof event.time === 'number' ? event.time : null;
      result.turn = Number(event.data?.turn ?? 0) || 0;
    }
    if (event.type === 'assistant/message' && result.reply === null) {
      result.reply = textOfContent(event.data?.message?.content);
      result.interrupted = event.data?.interrupted === true;
    }
    if (event.type === 'user/message' && result.task === null && event.data?.source?.kind === 'user') {
      result.task = textOfContent(event.data.content);
    }
    if (result.task !== null && result.reply !== null && result.turnStart !== null) break;
  }
  return result;
}

/**
 * Compose the "task finished" mail.
 *
 * @param input - the agent, its scanned session tail, the last error (if any),
 *   the clock reading, and the per-section character limits.
 */
export function buildIdleMail({ agent, scan, error, now = Date.now(), limits = {} }) {
  const taskChars = Number(limits.taskChars) > 0 ? Number(limits.taskChars) : 600;
  const replyChars = Number(limits.replyChars) > 0 ? Number(limits.replyChars) : 1500;
  const header = agent?.session?.header ?? {};
  const failed = error !== undefined && error !== null;
  const duration = scan.turnStart === null ? null : (scan.lastEventTime ?? now) - scan.turnStart;
  const lines = [];
  lines.push(failed ? '❌ DSH 任务出错' : '✅ DSH 任务完成');
  lines.push('');
  lines.push(`时间:   ${formatTime(now)}`);
  if (header.cwd) lines.push(`目录:   ${header.cwd}`);
  lines.push(`会话:   ${header.id ?? '未知'}`);
  lines.push(`回合:   第 ${scan.turn} 轮${duration === null ? '' : `　耗时: ${formatDuration(duration)}`}`);
  if (scan.interrupted) lines.push('备注:   本轮回答被中断');
  if (failed) {
    const message = error instanceof Error ? error.message : String(error);
    lines.push('');
    lines.push('── 错误 ──────────────────────');
    lines.push(clip(message, 800));
    if (error instanceof Error && typeof error.stack === 'string') {
      const stack = error.stack.split('\n').slice(1, 6).join('\n');
      if (stack.trim().length > 0) lines.push(clip(stack, 800));
    }
  }
  lines.push('');
  lines.push('── 任务 ──────────────────────');
  lines.push(scan.task ? clip(toPlainText(scan.task), taskChars) : '（未记录到用户消息）');
  lines.push('');
  lines.push('── 结果 ──────────────────────');
  lines.push(scan.reply ? clip(toPlainText(scan.reply), replyChars) : '（本轮没有文本回答）');
  lines.push('');
  lines.push('—— 由 DSH 邮件提醒插件自动发送');
  const taskLine = toPlainText(scan.task ?? '').split('\n')[0].trim();
  const subject = `${failed ? '❌ 任务出错' : '✅ 任务完成'}${taskLine ? ` · ${[...taskLine].slice(0, 30).join('')}` : ''}`;
  return { subject, text: lines.join('\n') };
}

/** Compose the "DSH is waiting for your answer" mail. */
export function buildQuestionMail({ agent, questions, now = Date.now() }) {
  const header = agent?.session?.header ?? {};
  const lines = [];
  lines.push('❓ DSH 需要你回复');
  lines.push('');
  lines.push(`时间:   ${formatTime(now)}`);
  if (header.cwd) lines.push(`目录:   ${header.cwd}`);
  lines.push(`会话:   ${header.id ?? '未知'}`);
  lines.push('');
  lines.push('── 问题 ──────────────────────');
  const list = Array.isArray(questions) ? questions : [];
  list.forEach((question, index) => {
    const title = [question?.header, question?.question].filter(Boolean).join(' — ');
    lines.push(`${index + 1}. ${toPlainText(title) || '(无标题问题)'}`);
    if (question?.detail) lines.push(`   ${clip(toPlainText(question.detail), 1200).replace(/\n/g, '\n   ')}`);
    const options = Array.isArray(question?.options) ? question.options : [];
    options.forEach((option, optionIndex) => {
      const letter = String.fromCharCode(65 + optionIndex);
      const description = option?.description ? ` — ${toPlainText(option.description)}` : '';
      lines.push(`   ${letter}. ${toPlainText(option?.label ?? '')}${description}`);
    });
    if (question?.multiSelect) lines.push('   （可多选）');
    lines.push('');
  });
  lines.push('回到 DSH 界面回答后，任务会继续。');
  lines.push('');
  lines.push('—— 由 DSH 邮件提醒插件自动发送');
  const first = toPlainText(list[0]?.question ?? '有待回答的问题').replace(/\s+/g, ' ');
  const subject = `❓ 需要你回复 · ${[...String(first).replace(/\s+/g, ' ')].slice(0, 30).join('')}`;
  return { subject, text: lines.join('\n') };
}

/** Deliver one composed mail, containing every failure into the log. */
async function deliver(deps, mail, tag, sessionId) {
  const { logger, config, inbound } = deps;
  const body = `To: ${config.to}\nSubject: ${config.subjectPrefix} ${mail.subject}\n\n${mail.text}\n`;
  if (config.logMail || config.dryRun) logger.info(`[${tag}] ${config.dryRun ? '(dry run) ' : ''}\n${body}`);
  if (config.outboxFile) {
    try {
      await appendFile(config.outboxFile, `\n===== ${formatTime(Date.now())} [${tag}] =====\n${body}`, 'utf8');
    } catch (error) {
      logger.warn(`could not write outbox file: ${String(error)}`);
    }
  }
  if (config.dryRun) return;
  const messageId = buildMessageId(config.from);
  try {
    await sendMailWithRetry({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      user: config.smtp.user,
      pass: config.smtp.pass,
      from: config.from,
      to: config.to,
      subject: `${config.subjectPrefix} ${mail.subject}`,
      text: mail.text,
      messageId,
      timeoutMs: config.smtp.timeoutMs,
      allowInvalidCert: config.smtp.allowInvalidCert,
    }, Math.max(1, Number(config.smtp.attempts) || 1));
    // Remember the thread so a reply can be routed back to this Session.
    inbound?.recordMessageId(messageId, sessionId);
    logger.info(`${tag} mail sent to ${config.to}`);
  } catch (error) {
    logger.warn(`${tag} mail failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Mount the notifier.
 *
 * @param ctx - plugin context; every listener is disposed with it.
 * @param rawConfig - profile config: recipients, SMTP account and switches.
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  // `ctx.logger` is a core Cordis service; the console fallback only keeps a
  // foreign container from turning a log line into a load failure.
  const base = ctx.logger ?? console;
  const logger = {
    info: (message) => base.info(`email-notify: ${message}`),
    warn: (message) => base.warn(`email-notify: ${message}`),
  };

  const warn = logger.warn;
  if (!config.enabled) {
    logger.info('disabled by config');
    return;
  }
  const problems = [];
  if (!config.to) problems.push('`to` (recipient) is empty');
  if (!config.smtp.host) problems.push('`smtp.host` is empty');
  // `dryRun` only composes and logs, so it needs no account at all.
  if (!config.dryRun) {
    if (!config.smtp.user) problems.push('`smtp.user` is empty');
    if (!config.smtp.pass) problems.push('`smtp.pass` (SMTP authorization code) is empty');
  }
  if (problems.length > 0) {
    warn(`not configured yet, staying idle — ${problems.join('; ')}`);
    return;
  }
  logger.info(`active — ${config.to} via ${config.smtp.host}:${config.smtp.port}${config.dryRun ? ' (dry run)' : ''}`);

  // Inbound: only useful when the outbound side is a real account.
  let inbound;
  if (config.inbound.enabled && !config.dryRun) {
    const missing = [];
    if (!config.inbound.user) missing.push('inbound.user');
    if (!config.inbound.pass) missing.push('inbound.pass');
    if (!config.inbound.workspacePath) missing.push('inbound.workspacePath (新会话用哪个工作目录)');
    if (missing.length > 0) {
      warn(`inbound disabled — missing ${missing.join('; ')}`);
    } else {
      inbound = startInbound({
        ctx,
        logger,
        config,
        // Tell the user when a mailed instruction could not be handed to DSH.
        onFailure: async (mail, outcome) => {
          const reason = String(outcome).replace(/^failed\((.*)\)$/, '$1');
          await deliver({ logger, config, inbound: undefined }, {
            subject: `⚠️ 邮件指令未能执行 · ${String(mail?.subject ?? '').slice(0, 30)}`,
            text: [
              '⚠️ 你发来的邮件指令没有被执行',
              '',
              `时间:   ${formatTime(Date.now())}`,
              `主题:   ${mail?.subject ?? '(无)'}`,
              `原因:   ${reason}`,
              '',
              '── 你的指令 ──────────────────────',
              clip(toPlainText(mail?.text ?? ''), 500),
              '',
              '检查 profile 里的 inbound 配置（agentPreset / permissionPreset / workspacePath）后重发一次即可。',
              '',
              '—— 由 DSH 邮件提醒插件自动发送',
            ].join('\n'),
          }, 'inbound-error', undefined);
        },
      });
    }
  }
  const deps = { logger, config, inbound };

  const timers = new Set();
  /** Per-agent bookkeeping: the last turn we mailed about, and the last error. */
  const agents = new WeakMap();
  const stateFor = (agent) => {
    let state = agents.get(agent);
    if (!state) {
      state = { lastTurn: -1, error: null, timer: null };
      agents.set(agent, state);
    }
    return state;
  };
  const notifiedQuestions = new Set();

  /** Root sessions only: children are an implementation detail of a parent task. */
  const shouldNotify = (agent) => {
    if (!agent) return false;
    if (!config.skipSubagents) return true;
    const header = agent.session?.header;
    if (!header) return true;
    if (header.origin === 'subagent') return false;
    return !(Number(header.delegationDepth) > 0);
  };

  ctx.on('agent/error', ({ agent, error }) => {
    if (!agent) return;
    stateFor(agent).error = error ?? new Error('unknown agent error');
  });

  ctx.on('agent/turn-stopping', ({ agent }) => {
    // A fresh turn clears the previous failure marker.
    if (agent) stateFor(agent).error = null;
  });

  const notifyIdle = async (agent) => {
    try {
      if (agent.status !== 'idle') return; // a multi-round goal resumed meanwhile
      const state = stateFor(agent);
      const session = agent.session;
      const scan = scanSession(session);
      const sessionKey = session?.header?.id ?? 'unknown';
      if (scan.turn <= 0 && scan.reply === null) return;
      if (state.lastTurn >= scan.turn) return; // already mailed about this turn
      const duration = scan.turnStart === null ? null : (scan.lastEventTime ?? Date.now()) - scan.turnStart;
      if (duration !== null && duration < config.minDurationMs) return;
      state.lastTurn = scan.turn;
      const error = state.error;
      state.error = null;
      const mail = buildIdleMail({
        agent,
        scan,
        error,
        limits: { taskChars: config.taskChars, replyChars: config.replyChars },
      });
      await deliver(deps, mail, `task-${sessionKey}#${scan.turn}`, sessionKey);
    } catch (error) {
      warn(`task notification failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  if (config.notifyOnIdle) {
    ctx.on('agent/status', ({ agent, status }) => {
      if (status !== 'idle' || !agent || !shouldNotify(agent)) return;
      const state = stateFor(agent);
      if (state.timer) return;
      if (config.idleDelayMs <= 0) {
        void notifyIdle(agent);
        return;
      }
      const timer = setTimeout(() => {
        timers.delete(timer);
        state.timer = null;
        void notifyIdle(agent);
      }, config.idleDelayMs);
      timer.unref?.();
      timers.add(timer);
      state.timer = timer;
    });
  }

  if (config.notifyOnQuestion) {
    ctx.on('user-questions/request', (request, next) => {
      try {
        const agent = request?.agent;
        const questions = Array.isArray(request?.questions) ? request.questions : [];
        if (questions.length > 0 && shouldNotify(agent)) {
          const sessionKey = agent?.session?.header?.id ?? 'unknown';
          const key = `${sessionKey}|${questions.map((question) => `${question?.id}:${question?.question}`).join('|')}`;
          if (!notifiedQuestions.has(key)) {
            notifiedQuestions.add(key);
            if (notifiedQuestions.size > 200) {
              const first = notifiedQuestions.values().next().value;
              notifiedQuestions.delete(first);
            }
            const mail = buildQuestionMail({ agent, questions });
            void deliver(deps, mail, `question-${sessionKey}`, sessionKey);
          }
        }
      } catch (error) {
        warn(`question notification failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      // This event is a waterfall: always hand off to the next listener so the
      // real answerer still runs.
      return typeof next === 'function' ? next() : undefined;
    });
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      inbound?.stop();
    });
  }
}

/** Exported for the standalone test harness. */
export { DEFAULTS };
