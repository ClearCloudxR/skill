/**
 * Minimal dependency-free SMTP sender for the dsh-email-notify plugin.
 *
 * Supports implicit TLS (port 465, e.g. QQ/Foxmail) and STARTTLS (port 587),
 * AUTH LOGIN with an AUTH PLAIN fallback, and UTF-8 (base64) message bodies so
 * Chinese text survives every hop.
 */
import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const CRLF = '\r\n';

/** Base64 of a UTF-8 string. */
export function b64(value) {
  return Buffer.from(String(value), 'utf8').toString('base64');
}

/** RFC 2047 encode a header value only when it is not plain ASCII. */
export function encodeHeaderValue(value) {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${b64(value)}?=`;
}

/** Split a base64 payload into 76-character lines (RFC 2045). */
export function wrap76(text) {
  const lines = [];
  for (let i = 0; i < text.length; i += 76) lines.push(text.slice(i, i + 76));
  return lines.length > 0 ? lines : [''];
}

/** Local time as an RFC 2822 date with a numeric zone offset. */
export function rfc2822Date(date = new Date()) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n) => String(n).padStart(2, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const offset = `${sign}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}${pad(Math.abs(offsetMinutes) % 60)}`;
  return `${days[date.getDay()]}, ${pad(date.getDate())} ${months[date.getMonth()]} ${date.getFullYear()} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${offset}`;
}

/** Default EHLO name for this host. */
function heloName() {
  const host = os.hostname() || 'localhost';
  return /^[A-Za-z0-9.-]+$/.test(host) ? host : 'localhost';
}

/** Build one Message-ID for a sender address. */
export function buildMessageId(from) {
  const host = String(from ?? '').split('@')[1];
  const domain = (host ?? '').replace(/[^A-Za-z0-9.-]/g, '') || 'localhost';
  return `${randomUUID()}@${domain}`;
}

/** Assemble one RFC 5322 message with a base64 UTF-8 text body. */
export function buildMessage({ from, to, subject, text, headers = {}, messageId }) {
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeaderValue(subject)}`,
    `Date: ${rfc2822Date()}`,
    `Message-ID: <${messageId ?? buildMessageId(from)}>`,
    'MIME-Version: 1.0',
    // Marks our own outbound mail as machine-generated so the inbound poller
    // (and well-behaved autoresponders) can recognise and skip it.
    'Auto-Submitted: auto-generated',
    'X-DSH-Notify: 1',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ];
  for (const [key, value] of Object.entries(headers)) lines.push(`${key}: ${encodeHeaderValue(String(value))}`);
  lines.push('', ...wrap76(b64(text)));
  return lines.join(CRLF);
}

/** Error carrying the SMTP status the server answered with. */
export class SmtpError extends Error {
  constructor(message, code, response) {
    super(message);
    this.name = 'SmtpError';
    this.code = code;
    this.response = response;
  }
}

/**
 * One SMTP connection with a strict request/response queue. At most one
 * command is outstanding at a time, which is what the protocol guarantees.
 * Exported for the socket-lifecycle tests.
 */
export class SmtpClient {
  constructor({ host, port, secure, timeoutMs, allowInvalidCert }) {
    this.host = host;
    this.port = port;
    this.secure = secure;
    this.timeoutMs = timeoutMs;
    this.allowInvalidCert = allowInvalidCert;
    this.socket = null;
    this.buffer = '';
    this.lines = [];
    this.waiters = [];
    this.failure = null;
    this.timer = null;
  }

  connect() {
    const options = {
      host: this.host,
      port: this.port,
      // QQ/Foxmail and most providers present a matching certificate; keep
      // verification on unless the operator explicitly opts out.
      rejectUnauthorized: !this.allowInvalidCert,
    };
    const socket = this.secure
      ? tls.connect({ ...options, servername: this.host })
      : net.connect(options);
    // Install the error sink BEFORE anything can await: an unhandled socket
    // 'error' is an uncaught exception, and inside the DSH host that kills the
    // whole application.
    socket.on('error', () => {});
    const ready = new Promise((resolve, reject) => {
      const event = this.secure ? 'secureConnect' : 'connect';
      const onReady = () => { socket.off('error', onError); resolve(); };
      const onError = (error) => { socket.off(event, onReady); reject(error); };
      socket.once(event, onReady);
      socket.once('error', onError);
    });
    this.#attach(socket);
    this.timer = setTimeout(
      () => this.#fail(new Error(`SMTP timeout after ${this.timeoutMs} ms`)),
      this.timeoutMs,
    );
    this.timer.unref?.();
    return ready;
  }

  #attach(socket) {
    this.socket = socket;
    this.onData = (chunk) => {
      this.buffer += chunk.toString('utf8');
      this.#drain();
    };
    this.onError = (error) => this.#fail(error);
    this.onClose = () => this.#fail(new Error('SMTP connection closed by the server'));
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
    // with no listener is an uncaught exception that kills the DSH host, so a
    // detached socket must never go unattended.
    socket.on('error', () => {});
  }

  #fail(error) {
    if (this.failure) return;
    this.failure = error;
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter.reject(error);
  }

  #drain() {
    const parts = this.buffer.split(/\r\n|\n/);
    this.buffer = parts.pop() ?? '';
    for (const line of parts) if (line.length > 0) this.lines.push(line);
    while (this.waiters.length > 0) {
      const index = this.lines.findIndex((line) => /^\d{3} /.test(line));
      if (index === -1) break;
      const consumed = this.lines.splice(0, index + 1);
      const last = consumed[consumed.length - 1];
      const response = {
        code: Number(last.slice(0, 3)),
        text: consumed.map((line) => line.slice(4)).join('\n'),
        lines: consumed,
      };
      this.waiters.shift().resolve(response);
    }
  }

  next() {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this.#drain();
    });
  }

  async command(line) {
    if (this.failure) throw this.failure;
    this.socket.write(line + CRLF);
    return await this.next();
  }

  async startTls() {
    const plain = this.socket;
    const secured = await new Promise((resolve, reject) => {
      const socket = tls.connect({
        socket: plain,
        servername: this.host,
        rejectUnauthorized: !this.allowInvalidCert,
      });
      socket.on('error', () => {});
      socket.once('secureConnect', () => resolve(socket));
      socket.once('error', reject);
    });
    this.#detach();
    this.buffer = '';
    this.lines = [];
    this.#attach(secured);
    this.secure = true;
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

/** Throw unless the response status is one of the accepted codes. */
function expect(response, codes, label) {
  if (codes.includes(response.code)) return response;
  throw new SmtpError(`${label} failed: ${response.code} ${response.text.trim()}`, response.code, response);
}

/** Authenticate with AUTH LOGIN, falling back to AUTH PLAIN. */
async function authenticate(client, user, pass) {
  const login = await client.command('AUTH LOGIN');
  if (login.code === 235) return;
  if (login.code === 504 || login.code === 500 || login.code === 502 || login.code === 503) {
    const plain = await client.command(`AUTH PLAIN ${b64(`\0${user}\0${pass}`)}`);
    expect(plain, [235], 'SMTP AUTH PLAIN');
    return;
  }
  expect(login, [334], 'SMTP AUTH LOGIN');
  const named = await client.command(b64(user));
  expect(named, [334], 'SMTP AUTH LOGIN (username)');
  const secret = await client.command(b64(pass));
  expect(secret, [235], 'SMTP AUTH LOGIN (password) — check the SMTP authorization code');
}

/** Parse one comma/semicolon/space separated recipient list. */
export function parseRecipients(value) {
  return String(value ?? '')
    .split(/[,;\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry.includes('@'));
}

/**
 * Deliver one plain-text message.
 *
 * @param options - SMTP connection, credentials and the message itself.
 * @returns the SMTP transcript for diagnostics.
 */
export async function sendMail(options) {
  const {
    host,
    port = 465,
    secure = Number(port) === 465,
    user,
    pass,
    from,
    to,
    subject,
    text,
    timeoutMs = 30000,
    allowInvalidCert = false,
  } = options;

  if (!host) throw new Error('SMTP host is required');
  const recipients = parseRecipients(to);
  if (recipients.length === 0) throw new Error(`no valid recipient in ${JSON.stringify(to)}`);
  const sender = from || user;
  if (!sender) throw new Error('a sender address (from) or SMTP user is required');

  const client = new SmtpClient({
    host,
    port: Number(port),
    secure: Boolean(secure),
    timeoutMs,
    allowInvalidCert,
  });
  const transcript = [];
  try {
    await client.connect();
    let response = await client.next();
    transcript.push(`${response.code} ${response.text.trim()}`);
    expect(response, [220], 'SMTP greeting');

    response = await client.command(`EHLO ${heloName()}`);
    transcript.push(`EHLO -> ${response.code}`);
    expect(response, [250], 'EHLO');

    if (!client.secure) {
      response = await client.command('STARTTLS');
      transcript.push(`STARTTLS -> ${response.code}`);
      expect(response, [220], 'STARTTLS');
      await client.startTls();
      response = await client.command(`EHLO ${heloName()}`);
      transcript.push(`EHLO(TLS) -> ${response.code}`);
      expect(response, [250], 'EHLO after STARTTLS');
    }

    if (user) {
      await authenticate(client, user, pass);
      transcript.push('AUTH -> 235');
    }

    response = await client.command(`MAIL FROM:<${sender}>`);
    transcript.push(`MAIL FROM -> ${response.code}`);
    expect(response, [250], 'MAIL FROM');

    for (const recipient of recipients) {
      response = await client.command(`RCPT TO:<${recipient}>`);
      transcript.push(`RCPT TO <${recipient}> -> ${response.code}`);
      expect(response, [250, 251], `RCPT TO <${recipient}>`);
    }

    response = await client.command('DATA');
    transcript.push(`DATA -> ${response.code}`);
    expect(response, [354], 'DATA');

    const message = buildMessage({
      from: sender,
      to: recipients.join(', '),
      subject,
      text,
      messageId: options.messageId,
    });
    client.socket.write(message + CRLF + `.${CRLF}`);
    response = await client.next();
    transcript.push(`message -> ${response.code} ${response.text.trim()}`);
    expect(response, [250], 'message body');

    try {
      await client.command('QUIT');
    } catch {
      /* QUIT is a courtesy; the message is already accepted */
    }
    return transcript;
  } finally {
    client.close();
  }
}

/** Connect, EHLO (and STARTTLS) without authenticating — a reachability probe. */
export async function probe({ host, port = 465, secure = Number(port) === 465, timeoutMs = 15000, allowInvalidCert = false }) {
  const client = new SmtpClient({ host, port: Number(port), secure: Boolean(secure), timeoutMs, allowInvalidCert });
  try {
    await client.connect();
    const greeting = await client.next();
    expect(greeting, [220], 'SMTP greeting');
    let response = await client.command(`EHLO ${heloName()}`);
    expect(response, [250], 'EHLO');
    if (!client.secure) {
      const started = await client.command('STARTTLS');
      expect(started, [220], 'STARTTLS');
      await client.startTls();
      response = await client.command(`EHLO ${heloName()}`);
      expect(response, [250], 'EHLO after STARTTLS');
    }
    try {
      await client.command('QUIT');
    } catch {
      /* ignore */
    }
    return { greeting: greeting.text.trim(), capabilities: response.lines.map((line) => line.slice(4)) };
  } finally {
    client.close();
  }
}

/** Retry wrapper used by the plugin: one retry covers a transient network drop. */
export async function sendMailWithRetry(options, attempts = 2) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await sendMail(options);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
  }
  throw lastError;
}
