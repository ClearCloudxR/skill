/**
 * Inbound side: poll the mailbox over IMAP and turn mail from the owner into
 * DSH work.
 *
 *   reply to a notification mail  -> continue that Session (In-Reply-To match)
 *   any other allowed mail        -> start a new Session through ctx.webhookRuntime
 *
 * Nothing in the mailbox is modified: no mail is marked read, moved or deleted.
 * Already-seen mail is skipped by a monotonic UID watermark kept in a state
 * file, so a restart never replays old messages.
 */
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fetchNewMessages, probeImap } from './imap.js';
import { parseMessage, stripQuoted } from './mime.js';

const RULE_ID = 'dsh-email-notify-inbound';
const MAX_REMEMBERED_MESSAGES = 200;

/** Build the minimal user message the agent loop accepts (role/content/source/id). */
function userMessage({ text, mail }) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: 'email',
      form: 'notice',
      from: mail.fromAddress,
      subject: mail.subject,
      summary: `email from ${mail.fromAddress}`,
    },
  };
}

/**
 * Normalize a subject for thread matching: drop reply/forward prefixes so a
 * client that does not send In-Reply-To (most phone mail apps) still matches
 * the notification it quotes.
 *
 * @param subject - the raw Subject header.
 * @returns a lowercase key without reply prefixes, or an empty string.
 */
export function normalizeSubject(subject) {
  let value = String(subject ?? '').trim().toLowerCase();
  if (value === '') return '';
  let previous;
  do {
    previous = value;
    value = value
      .replace(/^\s*(?:re|fw|fwd|答复|回复|转发|轉發)\s*(?:\[\d+\])?\s*[:：]\s*/i, '')
      .replace(/^\s*\[[^\]]{0,40}\]\s*/, (match) => (/dsh/i.test(match) ? match : ''))
      .trim();
  } while (value !== previous && value !== '');
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Decide what one parsed mail should do, without touching DSH.
 *
 * @param mail - a `parseMessage` result.
 * @param options - allowed sender set, remembered thread maps, and a liveness
 *   probe for a mapped Session.
 * @returns `{ action: 'skip', reason }`, `{ action: 'continue', sessionId, body }`
 *   or `{ action: 'new', reason, body }`.
 */
export function classifyMail(mail, {
  allowed,
  messageIds = {},
  subjects = {},
  isLive = () => false,
  replyToSession = true,
}) {
  if (!mail || typeof mail !== 'object') return { action: 'skip', reason: 'unparsable mail' };
  const body = stripQuoted(mail.text ?? '').trim();
  if (body === '') return { action: 'skip', reason: 'empty body after removing the quote' };
  if (!allowed.has(String(mail.fromAddress ?? '').toLowerCase())) {
    return { action: 'skip', reason: `sender ${mail.fromAddress || '(unknown)'} is not allowed` };
  }
  if (/auto-(generated|replied|notified)/i.test(mail.autoSubmitted ?? '')) {
    return { action: 'skip', reason: 'Auto-Submitted header (machine mail)' };
  }
  if (mail.headers?.['x-dsh-notify']) return { action: 'skip', reason: 'our own notification mail' };
  if (replyToSession) {
    // 1) The proper way: the reply quotes our Message-ID.
    for (const candidate of [mail.inReplyTo, ...(mail.references ?? [])].filter(Boolean)) {
      const sessionId = messageIds[candidate];
      if (!sessionId) continue;
      if (isLive(sessionId)) return { action: 'continue', sessionId, body };
      return { action: 'new', reason: `session ${sessionId} is not running`, body };
    }
    // 2) Fallback for clients that drop In-Reply-To: match the quoted subject.
    const bySubject = subjects[normalizeSubject(mail.subject)];
    if (bySubject) {
      if (isLive(bySubject)) return { action: 'continue', sessionId: bySubject, body };
      return { action: 'new', reason: `session ${bySubject} is not running`, body };
    }
  }
  return { action: 'new', reason: 'no matching notification thread', body };
}

/**
 * Start the inbound poller.
 *
 * @param options - plugin context, logger, resolved plugin config, and a
 *   callback used to report unexpected polling failures.
 * @returns a handle with `stop()` and `recordMessageId()`.
 */
export function startInbound({ ctx, logger, config, onFailure }) {
  const inbound = config.inbound;
  const state = {
    uidValidity: null,
    lastUid: 0,
    messageIds: {},
    subjects: {},
  };
  let timer = null;
  let stopped = false;
  let polling = false;
  let ruleRegistered = false;

  const imapConfig = () => ({
    host: inbound.host,
    port: inbound.port,
    secure: inbound.secure,
    user: inbound.user,
    pass: inbound.pass,
    mailbox: inbound.mailbox,
    timeoutMs: inbound.timeoutMs,
    // Read-only: EXAMINE never changes flags in the mailbox.
    readOnly: true,
    allowInvalidCert: inbound.allowInvalidCert,
  });

  const allowed = new Set(
    (inbound.allowFrom.length > 0 ? inbound.allowFrom : [config.smtp.user])
      .map((entry) => String(entry).trim().toLowerCase())
      .filter(Boolean),
  );

  async function loadState() {
    if (!inbound.stateFile) return;
    try {
      const raw = await readFile(inbound.stateFile, 'utf8');
      // Tolerate a UTF-8 BOM: PowerShell's Set-Content adds one, and a failed
      // parse would silently look like a first run and re-baseline the mailbox.
      const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
      state.uidValidity = parsed.uidValidity ?? null;
      state.lastUid = Number(parsed.lastUid) || 0;
      state.messageIds = parsed.messageIds && typeof parsed.messageIds === 'object' ? parsed.messageIds : {};
      state.subjects = parsed.subjects && typeof parsed.subjects === 'object' ? parsed.subjects : {};
    } catch {
      // First run (or unreadable state): the baseline below skips all backlog.
    }
  }

  async function saveState() {
    if (!inbound.stateFile) return;
    try {
      await mkdir(dirname(inbound.stateFile), { recursive: true });
      await writeFile(inbound.stateFile, JSON.stringify(state, null, 2), 'utf8');
    } catch (error) {
      logger.warn(`could not save inbound state: ${String(error)}`);
    }
  }

  /**
   * Remember which notification mail belongs to which Session — by Message-ID
   * and by normalized subject, so clients that drop In-Reply-To still route.
   */
  function recordMessageId(messageId, sessionId, subject) {
    if (!messageId || !sessionId || !inbound.enabled) return;
    const keys = Object.keys(state.messageIds);
    if (keys.length >= MAX_REMEMBERED_MESSAGES) {
      for (const key of keys.slice(0, keys.length - MAX_REMEMBERED_MESSAGES + 1)) delete state.messageIds[key];
    }
    state.messageIds[messageId] = sessionId;
    const key = normalizeSubject(subject);
    const subjectKeys = Object.keys(state.subjects);
    if (subjectKeys.length >= MAX_REMEMBERED_MESSAGES) {
      for (const old of subjectKeys.slice(0, subjectKeys.length - MAX_REMEMBERED_MESSAGES + 1)) delete state.subjects[old];
    }
    if (key) state.subjects[key] = sessionId;
    void saveState();
  }

  /** Register the webhook rule once the runtime is available. */
  function ensureRule() {
    if (ruleRegistered) return ctx.get('webhookRuntime');
    const runtime = ctx.get('webhookRuntime');
    if (!runtime || typeof runtime.register !== 'function') return undefined;
    runtime.register({
      id: RULE_ID,
      kind: 'email',
      run: (delivery) => {
        const payload = delivery?.payload ?? {};
        const body = String(payload.body ?? '').trim();
        if (body === '' || !inbound.workspacePath) return null;
        return {
          workspacePath: inbound.workspacePath,
          title: `📧 ${String(payload.subject ?? '邮件任务').slice(0, 60)}`,
          prompt: body,
          agentPreset: inbound.agentPreset,
          permissionPreset: inbound.permissionPreset,
        };
      },
    });
    ruleRegistered = true;
    logger.info('inbound: routing new mail through ctx.webhookRuntime');
    return runtime;
  }

  /**
   * Start a Session without the webhook runtime, following the same steps its
   * own session creator performs: resolve the agent preset, create the agent,
   * attach it to a workspace, apply the permission preset and title, then
   * admit the prompt.
   */
  async function createSessionDirect(mail, body) {
    const services = {
      agents: ctx.get('agents'),
      agentPresets: ctx.get('agentPresets'),
      permissionPresets: ctx.get('permissionPresets'),
      sessionTitle: ctx.get('sessionTitle'),
      workspaceRegistry: ctx.get('workspaceRegistry'),
    };
    const missing = Object.entries(services).filter(([, value]) => !value || typeof value !== 'object').map(([key]) => key);
    if (missing.length > 0) throw new Error(`missing DSH services: ${missing.join(', ')}`);

    const preset = await services.agentPresets.resolve(inbound.agentPreset);
    const scope = typeof services.agentPresets.acquireScope === 'function'
      ? await services.agentPresets.acquireScope(preset.id)
      : undefined;
    try {
      const workspace = await services.workspaceRegistry.create(inbound.workspacePath);
      const sessionId = `email-${randomUUID()}`;
      const selected = ctx.get('agentDefaultModel')?.currentSelection?.() ?? {};
      const handle = await services.agents.create({
        sessionId,
        meta: { cwd: workspace.path, agentPreset: preset.id },
        ...selected.provider && selected.model
          ? { agentOptions: { provider: selected.provider, model: selected.model } }
          : {},
        setup: async (agentCtx) => {
          await services.agentPresets.mount(agentCtx, preset.id);
        },
      });
      await workspace.attachSession(sessionId);
      services.permissionPresets.set(handle.agent.session, inbound.permissionPreset);
      services.sessionTitle.rename(handle.agent.session, `📧 ${String(mail.subject || '邮件任务').slice(0, 60)}`);
      handle.agent.followup(userMessage({ text: body, mail }));
      return sessionId;
    } finally {
      if (scope) {
        if (typeof scope[Symbol.asyncDispose] === 'function') await scope[Symbol.asyncDispose]();
        else if (typeof scope[Symbol.dispose] === 'function') scope[Symbol.dispose]();
        else if (typeof scope.dispose === 'function') await scope.dispose();
      }
    }
  }

  /** Route one parsed mail to an existing Session, or start a new one. */
  async function deliver(mail, uid) {
    const decision = classifyMail(mail, {
      allowed,
      messageIds: state.messageIds,
      subjects: state.subjects,
      isLive: (sessionId) => Boolean(ctx.get('agents')?.get(sessionId)),
      replyToSession: inbound.replyToSession,
    });
    if (decision.action === 'skip') return `skipped (${decision.reason})`;
    if (decision.action === 'continue') {
      const agent = ctx.get('agents').get(decision.sessionId);
      agent.followup(userMessage({ text: decision.body, mail }));
      return `continued ${decision.sessionId}`;
    }
    if (decision.reason) logger.info(`inbound: new Session — ${decision.reason}`);

    const runtime = ensureRule();
    if (runtime) {
      runtime.dispatch({
        kind: 'email',
        source: 'imap',
        deliveryId: `uid-${uid}`,
        receivedAt: Date.now(),
        payload: { from: mail.fromAddress, subject: mail.subject, body: decision.body, uid },
      });
      return 'started-new-session';
    }
    const sessionId = await createSessionDirect(mail, decision.body);
    return `started-new-session(${sessionId})`;
  }

  /** One poll cycle. */
  async function poll() {
    if (stopped || polling) return;
    polling = true;
    try {
      const configForPoll = imapConfig();
      if (state.uidValidity === null) {
        // First run: remember where the mailbox is now and never touch the backlog.
        const probe = await probeImap(configForPoll);
        state.lastUid = Math.max(0, Number(probe.uidNext) - 1);
        // `probeImap` may not report UIDVALIDITY; one empty fetch pins it down.
        const pinned = await fetchNewMessages(configForPoll, { sinceUid: state.lastUid, limit: 1, markSeen: false });
        state.uidValidity = String(pinned.uidValidity ?? '');
        await saveState();
        logger.info(`inbound: baseline UID ${state.lastUid} (${probe.exists} message(s) already in ${inbound.mailbox} are ignored)`);
        return;
      }
      const result = await fetchNewMessages(configForPoll, {
        sinceUid: state.lastUid,
        limit: inbound.maxPerPoll,
        markSeen: false,
      });
      if (String(result.uidValidity ?? '') !== String(state.uidValidity ?? '')) {
        state.uidValidity = String(result.uidValidity ?? '');
        state.lastUid = Math.max(0, Number(result.uidNext) - 1);
        await saveState();
        logger.warn('inbound: mailbox UIDVALIDITY changed; re-baselined to skip the backlog');
        return;
      }
      const messages = [...(result.messages ?? [])].sort((left, right) => left.uid - right.uid);
      let handled = 0;
      for (const message of messages) {
        let outcome = 'skipped-unparsable';
        let parsed;
        try {
          parsed = parseMessage(message.raw);
          outcome = await deliver(parsed, message.uid);
        } catch (error) {
          outcome = `failed(${error instanceof Error ? error.message : String(error)})`;
        }
        // The watermark always advances: a permanently broken mail must not be
        // replayed on every poll. Reporting the failure is the caller's job.
        if (outcome.startsWith('failed(') && typeof onFailure === 'function') {
          try {
            await onFailure(parsed, outcome);
          } catch (error) {
            logger.warn(`inbound: could not report the failure: ${String(error)}`);
          }
        }
        state.lastUid = Math.max(state.lastUid, message.uid + 1);
        handled += 1;
        logger.info(`inbound: uid ${message.uid} -> ${outcome}`);
      }
      if (handled > 0) {
        state.lastUid = Math.max(state.lastUid, Number(result.uidNext) - 1);
        await saveState();
      }
    } catch (error) {
      logger.warn(`inbound: poll failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      polling = false;
    }
  }

  void (async () => {
    await loadState();
    // A short delay keeps startup light and lets the rest of the profile settle.
    timer = setInterval(() => void poll(), inbound.pollMs);
    timer.unref?.();
    setTimeout(() => void poll(), 5000).unref?.();
  })();

  return {
    recordMessageId,
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
