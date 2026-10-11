/**
 * Minimal dependency-free IMAP4rev1 client for the dsh-email-notify plugin.
 *
 * Scope: connect, LOGIN, optional ID (required by QQ/Foxmail or the server
 * answers "Unsafe Login"), SELECT/EXAMINE, UID SEARCH, UID FETCH with
 * BODY.PEEK[] and UID STORE. The parser is literal-aware so raw message
 * bodies are kept as bytes from the wire to the caller.
 *
 * The only exported surface is fetchNewMessages() and probeImap().
 */
import net from 'node:net';
import tls from 'node:tls';

const CRLF = '\r\n';
const DEFAULT_PORT = 993;
const DEFAULT_MAILBOX = 'INBOX';
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_LIMIT = 10;
/** Advertised to the server by the ID command (sender side, informational). */
const CLIENT_ID = { name: 'dsh-email-notify', version: '1.0', vendor: 'dsh' };

/**
 * @typedef {Object} ImapConfig
 * @property {string} host            e.g. 'imap.qq.com'
 * @property {number} [port]          default 993
 * @property {boolean} [secure]       default true (implicit TLS)
 * @property {string} user            full mailbox address
 * @property {string} pass            SMTP/IMAP authorization code
 * @property {string} [mailbox]       default 'INBOX'
 * @property {number} [timeoutMs]     default 30000
 * @property {boolean} [allowInvalidCert]
 * @property {boolean} [readOnly]     true selects with EXAMINE (no flag changes), default false
 */

/**
 * @typedef {Object} ImapMessage
 * @property {number} uid
 * @property {string[]} flags
 * @property {Buffer} raw
 */

/** Error carrying the tagged status the server answered with. */
export class ImapError extends Error {
  constructor(message, status, response) {
    super(message);
    this.name = 'ImapError';
    this.status = status;
    this.response = response;
  }
}

/** Quote a string for an IMAP atom argument (quoted-string form). */
function quote(value) {
  return `"${String(value).replace(/[\\"]/g, (char) => `\\${char}`)}"`;
}

/** Resolve config defaults exactly once. */
function normalizeConfig(config) {
  if (!config || typeof config !== 'object') throw new Error('IMAP config is required');
  const host = config.host;
  if (!host) throw new Error('IMAP host is required');
  const port = Number(config.port ?? DEFAULT_PORT) || DEFAULT_PORT;
  return {
    host,
    port,
    secure: config.secure !== undefined ? Boolean(config.secure) : port === 993,
    user: String(config.user ?? ''),
    pass: String(config.pass ?? ''),
    mailbox: String(config.mailbox ?? DEFAULT_MAILBOX),
    timeoutMs: Number(config.timeoutMs ?? DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    allowInvalidCert: Boolean(config.allowInvalidCert),
    readOnly: Boolean(config.readOnly),
  };
}

/**
 * One IMAP connection. Responses are framed as complete protocol lines
 * (literals included) before any waiter sees them, and at most one tagged
 * command is in flight at a time. Exported for the socket-lifecycle tests.
 */
export class ImapClient {
  constructor({ host, port, secure, timeoutMs, allowInvalidCert }) {
    this.host = host;
    this.port = port;
    this.secure = secure;
    this.timeoutMs = timeoutMs;
    this.allowInvalidCert = allowInvalidCert;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    /** Responses received but not yet claimed by a waiter. */
    this.responses = [];
    /** Waiters waiting for a tagged completion, oldest first. */
    this.waiters = [];
    this.failure = null;
    this.timer = null;
    /** Offset inside this.buffer up to which scanning is known incomplete. */
    this.highWater = 0;
  }

  connect() {
    const options = {
      host: this.host,
      port: this.port,
      // Providers present a matching certificate; keep verification on unless
      // the operator explicitly opts out.
      rejectUnauthorized: !this.allowInvalidCert,
    };
    const socket = this.secure
      ? tls.connect({ ...options, servername: this.host })
      : net.connect(options);
    // Install the error sink BEFORE anything can await: an unhandled socket
    // 'error' is an uncaught exception and takes the host process down.
    socket.on('error', () => {});
    // An implicit-TLS TLSSocket surfaces faults that originate in the raw TCP
    // socket it wraps; keep that layer attended as well. `_parent` is Node's
    // own private link, so treat it as optional rather than required.
    const parent = socket._parent;
    if (parent && parent !== socket && typeof parent.on === 'function') parent.on('error', () => {});
    const ready = new Promise((resolve, reject) => {
      const event = this.secure ? 'secureConnect' : 'connect';
      const onReady = () => { socket.off('error', onError); resolve(); };
      const onError = (error) => { socket.off(event, onReady); reject(error); };
      socket.once(event, onReady);
      socket.once('error', onError);
    });
    this.#attach(socket);
    this.timer = setTimeout(
      () => this.#fail(new Error(`IMAP timeout after ${this.timeoutMs} ms`)),
      this.timeoutMs,
    );
    this.timer.unref?.();
    return ready;
  }

  #attach(socket) {
    this.socket = socket;
    this.onData = (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.#drain();
    };
    this.onError = (error) => this.#fail(error);
    this.onClose = () => this.#fail(new Error('IMAP connection closed by the server'));
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
  }

  #detach() {
    const socket = this.socket;
    if (!socket) return;
    socket.off('data', this.onData);
    socket.off('error', this.onError);
    socket.off('close', this.onClose);
    // A TLS peer can reset the connection at any moment, and an 'error' event
    // with no listener is an uncaught exception. Inside the DSH host that
    // exception kills the whole application (observed: "read ECONNRESET" from
    // TLSWrap.onStreamRead), so a detached socket must never go unattended.
    socket.on('error', () => {});
  }

  #fail(error) {
    if (this.failure) return;
    this.failure = error;
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter.reject(error);
  }

  /**
   * Try to frame one complete protocol line out of this.buffer.
   * @returns {{ segments: Array<string|Buffer>, offset: number }|null} the
   *   response (text segments are ASCII, literal segments are raw bytes) and
   *   the number of bytes it occupied, or null when more data is needed.
   */
  #scanResponse(start) {
    let position = start;
    let lineStart = start;
    const segments = [];
    for (;;) {
      const crlf = this.buffer.indexOf('\r\n', position);
      if (crlf === -1) return null;
      const line = this.buffer.toString('latin1', lineStart, crlf);
      const literal = /\{(\d+)\}\s*$/.exec(line);
      if (!literal) {
        segments.push(this.buffer.toString('latin1', lineStart, crlf));
        return { segments, offset: crlf + 2 - start };
      }
      const size = Number(literal[1]);
      const dataStart = crlf + 2;
      if (this.buffer.length < dataStart + size) {
        // Partial literal: rescan from here as soon as more bytes arrive.
        this.highWater = start;
        return null;
      }
      if (line.length > literal[0].length) {
        segments.push(this.buffer.toString('latin1', lineStart, crlf - literal[0].length));
      }
      segments.push(this.buffer.subarray(dataStart, dataStart + size));
      position = dataStart + size;
      lineStart = position;
    }
  }

  #drain() {
    for (;;) {
      if (this.highWater > this.buffer.length) this.highWater = this.buffer.length;
      const scanned = this.#scanResponse(this.highWater);
      if (!scanned) return;
      const start = this.highWater;
      this.buffer = this.buffer.subarray(start + scanned.offset);
      this.highWater = 0;
      this.#emit(scanned.segments);
    }
  }

  #emit(segments) {
    const first = segments[0];
    const head = typeof first === 'string' ? first : first.toString('latin1');
    const tokens = head.split(' ');
    const tag = tokens[0];
    const untagged = tag === '*' || tag === '+';
    // Both forms carry a status word after the tag: 'a1 OK ...' and
    // '* OK [CAPABILITY ...]'. Data lines look like '* 5 EXISTS'.
    const status = (tokens[1] ?? '').toUpperCase() || null;
    const response = {
      tag,
      untagged,
      status,
      segments,
      text: segments.map((part) => (
        typeof part === 'string' ? part : part.toString('utf8')
      )).join(''),
    };
    this.responses.push(response);
    this.#settle();
  }

  /** Resolve every waiter whose completion has arrived, in registration order. */
  #settle() {
    while (this.waiters.length > 0) {
      const waiter = this.waiters[0];
      const end = this.responses.findIndex((entry) => waiter.matches(entry));
      if (end === -1) break;
      this.waiters.shift();
      const lines = this.responses.slice(0, end + 1);
      this.responses = this.responses.slice(end + 1);
      waiter.resolve(lines);
    }
  }

  /** Wait for the next tagged (or greeting) completion, collecting untagged lines. */
  #next(matches) {
    if (this.failure) return Promise.reject(this.failure);
    // The completion may already be queued: the greeting often arrives in the
    // I/O tick between the TLS handshake and the call that asks for it.
    const already = this.responses.findIndex((entry) => matches(entry));
    if (already !== -1) {
      const lines = this.responses.slice(0, already + 1);
      this.responses = this.responses.slice(already + 1);
      return Promise.resolve(lines);
    }
    return new Promise((resolve, reject) => {
      const waiter = { matches, resolve, reject };
      this.waiters.push(waiter);
      // Re-check after registering: a socket error landing in this tick must
      // not leave this promise pending forever.
      if (this.failure) {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(this.failure);
        return;
      }
      this.#drain();
    });
  }

  /** Read the server greeting ("* OK ..."). */
  greeting() {
    return this.#next((entry) => entry.untagged
      && (entry.status === 'OK' || entry.status === 'PREAUTH'));
  }

  /**
   * Send one command and wait for its tagged completion.
   * @param {string} tag unique command tag
   * @param {string} command command text without the trailing CRLF
   * @returns {Promise<Array<{tag: string, status: string|null, text: string}>>}
   *   every response line, untagged ones first and the tagged completion last
   */
  command(tag, command) {
    if (this.failure) return Promise.reject(this.failure);
    const matches = (entry) => entry.tag === tag;
    const pending = this.#next(matches);
    this.socket.write(`${tag} ${command}${CRLF}`);
    return pending;
  }

  close() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.#detach();
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    try {
      socket.end();
    } catch {
      /* the peer may already be gone */
    }
    const force = setTimeout(() => {
      try {
        socket.destroy();
      } catch {
        /* already destroyed */
      }
    }, 500);
    force.unref?.();
  }
}

/** Throw unless the tagged completion says OK. */
function expectOk(tag, responses, label) {
  const completion = responses[responses.length - 1];
  if (completion && completion.tag === tag && completion.status === 'OK') return responses;
  const status = completion?.status ?? 'UNKNOWN';
  throw new ImapError(
    `${label} failed: ${status} ${String(completion?.text ?? '').trim()}`.trim(),
    status,
    responses,
  );
}

/**
 * Session helper: login + ID, shared by fetchNewMessages() and probeImap().
 * @returns {Promise<{client: ImapClient, tag: () => string, run: Function, transcript: string[]}>}
 */
async function openSession(config) {
  if (!config.user) throw new Error('IMAP user is required');
  if (!config.pass) throw new Error('IMAP pass is required');

  const client = new ImapClient({
    host: config.host,
    port: config.port,
    secure: config.secure,
    timeoutMs: config.timeoutMs,
    allowInvalidCert: config.allowInvalidCert,
  });
  const transcript = [];
  let counter = 0;
  const tag = () => `a${(counter += 1)}`;

  try {
    await client.connect();
  } catch (error) {
    client.close();
    throw error;
  }
  const greeting = await client.greeting();
  const greetingText = greeting.map((line) => line.text.trim()).join(' | ');
  transcript.push(`greeting: ${greetingText}`);

  /**
   * Run one command, record it, and require a tagged OK.
   * @param {string} command IMAP command text without the trailing CRLF
   * @param {string} [label] name used in error messages
   * @returns {Promise<Array<{tag: string, status: string|null, text: string}>>}
   */
  const run = async (command, label) => {
    const current = tag();
    const responses = await client.command(current, command);
    const completion = responses[responses.length - 1];
    transcript.push(`${current} ${command} -> ${completion?.status ?? '?'} ${String(completion?.text ?? '').trim().slice(0, 200)}`);
    expectOk(current, responses, label ?? command);
    return responses;
  };

  try {
    await run(`LOGIN ${quote(config.user)} ${quote(config.pass)}`, 'IMAP LOGIN');
    // QQ/Foxmail reject every later command with "Unsafe Login" until the
    // client has introduced itself with ID (RFC 2971).
    await run(`ID ("name" ${quote(CLIENT_ID.name)} "version" ${quote(CLIENT_ID.version)}`
      + ` "vendor" ${quote(CLIENT_ID.vendor)})`, 'IMAP ID');
  } catch (error) {
    client.close();
    throw error;
  }

  return { client, tag, run, transcript, greetingText };
}

/** Uppercase first token of each capability line. */
function parseCapabilities(responses) {
  const found = [];
  for (const response of responses) {
    if (!response.untagged) continue;
    const match = /^\*\s+CAPABILITY\b([\s\S]*)$/i.exec(response.text);
    if (match) found.push(...match[1].trim().split(/\s+/).filter(Boolean));
  }
  return found;
}

/** First integer captured by a pattern in any response text. */
function firstNumber(responses, pattern) {
  for (const response of responses) {
    const match = pattern.exec(response.text);
    if (match) return Number(match[1]);
  }
  return undefined;
}

/** Parse SELECT/EXAMINE untagged data. */
function parseMailbox(responses) {
  const exists = firstNumber(responses, /^\*\s+(\d+)\s+EXISTS\b/im);
  const uidValidity = firstNumber(responses, /\[UIDVALIDITY\s+(\d+)\]/i);
  const uidNext = firstNumber(responses, /\[UIDNEXT\s+(\d+)\]/i);
  let unseen;
  for (const response of responses) {
    const match = /^\*\s+OK\s+\[UNSEEN\s+(\d+)\]/im.exec(response.text);
    if (match) {
      unseen = Number(match[1]);
      break;
    }
  }
  return { exists, uidValidity, uidNext, unseen };
}

/** Parse the numbers out of a `* SEARCH ...` line. */
function parseSearch(responses) {
  const uids = [];
  for (const response of responses) {
    const match = /^\*\s+SEARCH\b([\s\S]*)$/im.exec(response.text);
    if (!match) continue;
    for (const token of match[1].split(/\s+/)) {
      if (/^\d+$/.test(token)) uids.push(Number(token));
    }
  }
  return uids;
}

/**
 * Pick the response that actually carries the message: the untagged
 * `* N FETCH (...)` line with the BODY[] literal, not the tagged
 * `a5 OK Fetch completed` completion that closes the command.
 *
 * @param {Array<{segments?: Array<string|Buffer>}>} responses all responses of one UID FETCH
 * @returns {*} the response holding a literal, or the last one as a fallback
 */
export function pickFetchResponse(responses) {
  const list = Array.isArray(responses) ? responses : [];
  return list.find((response) => response?.segments?.some((part) => Buffer.isBuffer(part)))
    ?? list[list.length - 1]
    ?? { segments: [] };
}

/**
 * Parse one `* N FETCH (...)` response, keeping the message body as bytes.
 * UID and FLAGS are read from that same response.
 */
function parseFetch(response) {
  const segments = response?.segments ?? [];
  const uidMatch = /\bUID\s+(\d+)/i.exec(response?.text ?? '');
  const flagMatch = /\bFLAGS\s+\(([^)]*)\)/i.exec(response?.text ?? '');
  const literal = segments.find((part) => Buffer.isBuffer(part));
  return {
    uid: uidMatch ? Number(uidMatch[1]) : 0,
    flags: flagMatch ? flagMatch[1].trim().split(/\s+/).filter(Boolean) : [],
    raw: literal ?? Buffer.alloc(0),
  };
}

/** LOGOUT politely; failures are ignored because the session is over anyway. */
async function logout(run, client, transcript) {
  try {
    await run('LOGOUT', 'IMAP LOGOUT');
  } catch (error) {
    transcript.push(`LOGOUT: ${error.message}`);
  }
  client.close();
}

/**
 * One poll: connect, login, select, take new mail, optionally mark it seen, quit.
 *
 * @param {ImapConfig} config
 * @param {{ sinceUid?: number, limit?: number, markSeen?: boolean }} [options]
 * @returns {Promise<{ uidValidity: string, uidNext: number, messages: ImapMessage[], seen: number[], transcript: string[] }>}
 */
export async function fetchNewMessages(config, options = {}) {
  const settings = normalizeConfig(config);
  const sinceUid = Number(options.sinceUid ?? 0) || 0;
  const limit = Number(options.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT;
  const markSeen = options.markSeen !== undefined ? Boolean(options.markSeen) : true;

  const { client, run, transcript } = await openSession(settings);
  try {
    const select = settings.readOnly ? 'EXAMINE' : 'SELECT';
    const selected = await run(`${select} ${settings.mailbox}`, `${select} ${settings.mailbox}`);
    const mailbox = parseMailbox(selected);
    const uidValidity = String(mailbox.uidValidity ?? '');
    const uidNext = Number(mailbox.uidNext ?? 0);

    const searchResult = await run(
      `UID SEARCH ${sinceUid > 0 ? `UID ${sinceUid + 1}:*` : 'ALL'}`,
      'UID SEARCH',
    );
    let uids = parseSearch(searchResult);
    if (sinceUid > 0) uids = uids.filter((uid) => uid > sinceUid);
    if (uids.length > limit) uids = uids.slice(-limit);
    transcript.push(`candidates: ${uids.length ? uids.join(',') : 'none'}`);

    const messages = [];
    const seen = [];
    for (const uid of uids) {
      // BODY.PEEK[] never sets \Seen as a side effect of downloading.
      const fetched = await run(`UID FETCH ${uid} (UID FLAGS BODY.PEEK[])`, `UID FETCH ${uid}`);
      const parsed = parseFetch(pickFetchResponse(fetched));
      const message = {
        uid: parsed.uid || uid,
        flags: parsed.flags,
        raw: parsed.raw,
      };
      messages.push(message);
      const alreadySeen = message.flags.some((flag) => flag.toLowerCase() === '\\seen');
      if (markSeen && !settings.readOnly && !alreadySeen) {
        await run(`UID STORE ${uid} +FLAGS (\\Seen)`, `UID STORE ${uid}`);
        seen.push(uid);
      }
    }

    await logout(run, client, transcript);
    return { uidValidity, uidNext, messages, seen, transcript };
  } catch (error) {
    client.close();
    throw error;
  }
}

/**
 * Connect, login and report mailbox state without changing any flag.
 *
 * @param {ImapConfig} config
 * @returns {Promise<{ greeting: string, mailbox: string, exists: number, uidNext: number, unseen: number, capabilities: string[] }>}
 */
export async function probeImap(config) {
  const settings = normalizeConfig(config);
  const { client, run, transcript, greetingText } = await openSession(settings);
  try {
    const capabilities = parseCapabilities(await run('CAPABILITY', 'IMAP CAPABILITY'));
    const selected = await run(`EXAMINE ${settings.mailbox}`, `EXAMINE ${settings.mailbox}`);
    const mailbox = parseMailbox(selected);
    await logout(run, client, transcript);
    return {
      greeting: greetingText,
      mailbox: settings.mailbox,
      exists: Number(mailbox.exists ?? 0),
      uidNext: Number(mailbox.uidNext ?? 0),
      unseen: Number(mailbox.unseen ?? 0),
      capabilities,
    };
  } catch (error) {
    client.close();
    throw error;
  }
}
