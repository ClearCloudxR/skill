/**
 * Dependency-free MIME / RFC 5322 parser for the dsh-email-notify plugin.
 *
 * Handles folded headers, RFC 2047 encoded-words (B and Q), multipart bodies,
 * base64 and quoted-printable transfer encodings and a small set of charsets.
 * Malformed input never throws: the parser returns as much as it could read.
 */
import { TextDecoder } from 'node:util';

/**
 * @typedef {Object} ParsedMail
 * @property {Record<string,string>} headers  lowercase keys, folded lines unfolded
 * @property {string} from                    display name + address, RFC 2047 decoded
 * @property {string} fromAddress             bare address, lowercase
 * @property {string} to
 * @property {string} subject                 RFC 2047 decoded
 * @property {string} date
 * @property {string} messageId               without angle brackets
 * @property {string} inReplyTo
 * @property {string[]} references
 * @property {string} autoSubmitted           raw header value, '' when absent
 * @property {string} text                    best plain-text body (HTML is converted)
 * @property {boolean} hadHtml
 */

/** Charset aliases mapped onto a TextDecoder label, lowercased keys. */
const CHARSET_ALIASES = {
  'utf8': 'utf-8',
  'utf-8': 'utf-8',
  'unicode-1-1-utf-8': 'utf-8',
  'us-ascii': 'utf-8',
  'ascii': 'utf-8',
  'gb2312': 'gb18030',
  'gbk': 'gb18030',
  'gb18030': 'gb18030',
  'x-gbk': 'gb18030',
  'iso-8859-1': 'latin1',
  'iso8859-1': 'latin1',
  'latin1': 'latin1',
  'latin-1': 'latin1',
  'windows-1252': 'windows-1252',
  'cp1252': 'windows-1252',
  'big5': 'big5',
  'shift_jis': 'shift_jis',
  'sjis': 'shift_jis',
  'euc-jp': 'euc-jp',
  'euc-kr': 'euc-kr',
  'koi8-r': 'koi8-r',
};

/** Named HTML entities that matter for Chinese/typographic mail. */
const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  middot: '·',
  times: '×',
  divide: '÷',
  deg: '°',
  laquo: '«',
  raquo: '»',
  euro: '€',
  pound: '£',
  yen: '¥',
  sect: '§',
  para: '¶',
  dagger: '†',
  minus: '−',
  plusmn: '±',
};

/** Decode a byte buffer with the best matching charset, never throwing. */
function decodeCharset(bytes, charset) {
  const label = CHARSET_ALIASES[String(charset ?? '').trim().toLowerCase()];
  for (const candidate of [label, 'utf-8']) {
    if (!candidate) continue;
    try {
      return new TextDecoder(candidate, { fatal: false }).decode(bytes);
    } catch {
      /* unknown label: fall through to utf-8, then latin1 */
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return Buffer.from(bytes).toString('latin1');
  }
}

/** Split one header value into [text|encodedWord] pieces. */
function rfc2047Pieces(value) {
  const pieces = [];
  let text = '';
  let index = 0;
  const pushText = () => {
    if (text.length > 0) pieces.push({ text });
    text = '';
  };
  while (index < value.length) {
    const start = value.indexOf('=?', index);
    if (start === -1) {
      text += value.slice(index);
      break;
    }
    const match = /^=\?([^?\s]*)\?([bBqQ])\?([\s\S]*?)\?=/.exec(value.slice(start));
    if (!match) {
      text += value.slice(index, start + 2);
      index = start + 2;
      continue;
    }
    text += value.slice(index, start);
    pushText();
    pieces.push({ charset: match[1], encoding: match[2].toUpperCase(), payload: match[3] });
    index = start + match[0].length;
  }
  pushText();
  return pieces;
}

/**
 * Decode RFC 2047 encoded-words plus RFC 5322 unfolding.
 *
 * Per RFC 2047 whitespace between two adjacent encoded-words is not part of
 * the value and is dropped; whitespace inside an encoded-word (a Q-encoded
 * `_` or `=20`) is real content and survives.
 *
 * @param {string} value raw header value
 * @returns {string}
 */
export function decodeWords(value) {
  const input = String(value ?? '');
  const pieces = rfc2047Pieces(input);
  const out = [];
  let lastWasWord = false;
  // Consecutive encoded-words that share one charset are merged before
  // decoding, so a multi-byte character split across two words still decodes.
  // Words with different charsets must be decoded separately: concatenating
  // their bytes and decoding with one of the charsets corrupts the other.
  let bytes = Buffer.alloc(0);
  let charset = '';
  let pendingWhitespace = '';

  /** True once any real content (encoded or plain) has been emitted. */
  const hasContent = () => out.length > 0 || bytes.length > 0;
  /** Emit whatever encoded-word bytes are buffered. */
  const flush = () => {
    if (bytes.length > 0) out.push(decodeCharset(bytes, charset || 'utf-8'));
    bytes = Buffer.alloc(0);
    charset = '';
  };

  for (const piece of pieces) {
    if (piece.text !== undefined) {
      if (lastWasWord && /^[ \t\r\n]+$/.test(piece.text)) {
        // Whitespace between two adjacent encoded-words is dropped (RFC 2047).
        continue;
      }
      flush();
      // The single space after the header colon is a separator, not content.
      let text = hasContent() ? piece.text : piece.text.replace(/^[ \t]+/, '');
      if (pendingWhitespace && text.length > 0) {
        text = pendingWhitespace + text;
      }
      pendingWhitespace = '';
      if (text.length > 0) out.push(text);
      lastWasWord = false;
      continue;
    }
    if (pendingWhitespace) {
      out.push(pendingWhitespace);
      pendingWhitespace = '';
    }
    if (lastWasWord && charset === piece.charset) {
      bytes = Buffer.concat([bytes, decodeWordBytes(piece)]);
    } else {
      flush();
      charset = piece.charset;
      bytes = decodeWordBytes(piece);
    }
    lastWasWord = true;
  }
  flush();
  return out.join('');
}

/** Decode the payload of one encoded-word into raw bytes. */
function decodeWordBytes(piece) {
  try {
    if (piece.encoding === 'B') {
      return Buffer.from(String(piece.payload).replace(/\s+/g, ''), 'base64');
    }
    return decodeQuotedPrintableBytes(String(piece.payload).replace(/_/g, ' '));
  } catch {
    return Buffer.from(String(piece.payload), 'latin1');
  }
}

/** Decode a quoted-printable string into bytes, honouring soft line breaks. */
function decodeQuotedPrintableBytes(input) {
  const bytes = [];
  const text = String(input ?? '');
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char !== '=') {
      bytes.push(text.charCodeAt(index) & 0xff);
      continue;
    }
    if (text[index + 1] === '\r' && text[index + 2] === '\n') {
      index += 2;
      continue;
    }
    if (text[index + 1] === '\n') {
      index += 1;
      continue;
    }
    const hex = text.slice(index + 1, index + 3);
    if (/^[0-9a-fA-F]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
      continue;
    }
    bytes.push(0x3d); // a lone '=' is data
  }
  return Buffer.from(bytes);
}

/** Decode quoted-printable straight to text with a charset hint. */
export function decodeQuotedPrintable(input, charset = 'utf-8') {
  return decodeCharset(decodeQuotedPrintableBytes(input), charset);
}

/** Split raw headers into lowercase keys with unfolded values. */
function parseHeaders(text) {
  /** @type {Record<string,string>} */
  const headers = {};
  const order = [];
  for (const rawLine of String(text).split(/\r\n|\n/)) {
    if (rawLine.length === 0) continue;
    if (/^[ \t]/.test(rawLine) && order.length > 0) {
      const key = order[order.length - 1];
      headers[key] = `${headers[key]} ${rawLine.trim()}`;
      continue;
    }
    const colon = rawLine.indexOf(':');
    if (colon === -1) continue;
    const key = rawLine.slice(0, colon).trim().toLowerCase();
    if (key.length === 0) continue;
    headers[key] = rawLine.slice(colon + 1).trim();
    order.push(key);
  }
  return headers;
}

/**
 * Parse a header value into a primary value plus parameters.
 * @returns {{ value: string, params: Record<string,string> }}
 */
export function parseContentType(headerValue) {
  const segments = [];
  let current = '';
  let quoted = false;
  for (const char of String(headerValue ?? '')) {
    if (char === '"') {
      quoted = !quoted;
      current += char;
      continue;
    }
    if (char === ';' && !quoted) {
      segments.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  segments.push(current);

  const value = (segments.shift() ?? '').trim().toLowerCase();
  /** @type {Record<string,string>} */
  const params = {};
  for (const segment of segments) {
    const eq = segment.indexOf('=');
    if (eq === -1) continue;
    const name = segment.slice(0, eq).trim().toLowerCase();
    let raw = segment.slice(eq + 1).trim();
    if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) raw = raw.slice(1, -1);
    params[name] = raw.replace(/\\(.)/g, '$1');
  }
  return { value, params };
}

/** Find the first blank line that separates headers from the body. */
function splitHeaderBody(text) {
  const match = /\r?\n\r?\n/.exec(text);
  if (!match) return { header: text, body: '' };
  return { header: text.slice(0, match.index), body: text.slice(match.index + match[0].length) };
}

/** Slice a multipart body on its boundary into raw part chunks. */
function splitMultipart(body, boundary) {
  if (!boundary) return [];
  const chunks = [];
  let current = null;
  for (const line of body.split(/\r\n|\n/)) {
    if (line.trim() === `--${boundary}`) {
      if (current) chunks.push(current);
      current = [];
      continue;
    }
    if (line.trim() === `--${boundary}--`) {
      if (current) chunks.push(current);
      current = null;
      break;
    }
    if (current) current.push(line);
  }
  if (current) chunks.push(current);
  return chunks.filter((chunk) => chunk.length > 0).map((chunk) => chunk.join('\r\n'));
}

/** Turn the transfer encoding of one part into raw bytes. */
function decodeTransfer(body, encoding) {
  const kind = String(encoding ?? '').trim().toLowerCase();
  if (kind === 'base64') {
    let cleaned = String(body).replace(/[^A-Za-z0-9+/=]/g, '');
    if (cleaned.length % 4 !== 0) cleaned = cleaned.padEnd(cleaned.length + (4 - (cleaned.length % 4)), '=');
    return Buffer.from(cleaned, 'base64');
  }
  if (kind === 'quoted-printable') return decodeQuotedPrintableBytes(body);
  if (kind === 'binary') return Buffer.from(String(body), 'latin1');
  // 7bit / 8bit / anything unknown: raw single bytes in, same bytes out.
  return Buffer.from(String(body), 'latin1');
}

/** Best-effort entity and reference decoding for an HTML fragment. */
function decodeEntities(html) {
  return String(html ?? '').replace(
    /&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);?/g,
    (match, entity) => {
      if (entity.startsWith('#x') || entity.startsWith('#X')) {
        const code = Number.parseInt(entity.slice(2), 16);
        return Number.isFinite(code) && code > 0 ? safeFromCodePoint(code) : match;
      }
      if (entity.startsWith('#')) {
        const code = Number.parseInt(entity.slice(1), 10);
        return Number.isFinite(code) && code > 0 ? safeFromCodePoint(code) : match;
      }
      const named = NAMED_ENTITIES[entity.toLowerCase()];
      return named === undefined ? match : named;
    },
  );
}

/** fromCodePoint that tolerates out-of-range values. */
function safeFromCodePoint(code) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/**
 * Convert HTML into readable plain text: drop script/style, turn block tags
 * and <br> into line breaks, decode entities and squeeze blank lines.
 *
 * @param {string} html
 * @returns {string}
 */
export function htmlToText(html) {
  let text = String(html ?? '');
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  // Structural tags become one paragraph break each.
  text = text.replace(/<(?:br|hr)\s*\/?>/gi, '\n');
  text = text.replace(/<\/(?:p|div|tr|li|h[1-6]|table|blockquote|section|article|ul|ol|dl|pre)\s*>/gi, '\n\n');
  text = text.replace(/<(?:p|div|tr|li|h[1-6]|table|blockquote|section|article|ul|ol|dl|pre)\b[^>]*>/gi, '\n\n');
  text = text.replace(/<t[dh]\b[^>]*>/gi, '\t');
  text = text.replace(/<[^>]*>/g, '');
  text = decodeEntities(text);
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Bare lowercase address out of a header value, searching display names too. */
function extractAddress(value) {
  const text = String(value ?? '');
  const angled = /<([^<>]+)>/.exec(text);
  const candidate = (angled ? angled[1] : text).trim();
  const match = /[^\s<>,";:]+@[^\s<>,";:]+/.exec(candidate);
  return match ? match[0].replace(/[.,;]+$/, '').toLowerCase() : '';
}

/**
 * Recursively decide whether a part is an inline body or an attachment.
 *
 * @param {Record<string,string>} headers part headers
 * @returns {boolean}
 */
function isAttachment(headers) {
  const disposition = parseContentType(headers['content-disposition'] ?? '');
  if (disposition.value.includes('attachment')) return true;
  if (disposition.value.includes('inline') && disposition.params.filename) return true;
  return false;
}

/**
 * Recursively collect the best text body out of a MIME part.
 *
 * Preference is text/plain first, then text/html converted to text, which is
 * what parseMessage() documents.
 *
 * @param {Record<string,string>} headers
 * @param {string} body
 * @param {{ plain?: string, html?: string }} acc
 */
function collectText(headers, body, acc) {
  if (isAttachment(headers)) return;
  const type = parseContentType(headers['content-type'] ?? 'text/plain; charset=utf-8');
  const mime = type.value || 'text/plain';
  const encoding = headers['content-transfer-encoding'] ?? '';
  const charset = type.params.charset || 'utf-8';

  if (mime.startsWith('multipart/')) {
    const boundary = type.params.boundary;
    for (const chunk of splitMultipart(body, boundary)) {
      const parts = splitHeaderBody(chunk);
      collectText(parseHeaders(parts.header), parts.body, acc);
    }
    return;
  }

  const bytes = decodeTransfer(body, encoding);
  const chunk = mime.startsWith('text/')
    ? decodeCharset(bytes, charset)
    : bytes.toString('latin1');

  if (mime === 'text/html') {
    if (acc.html === undefined) acc.html = chunk;
    return;
  }
  if (mime === 'text/plain' || mime.startsWith('text/')) {
    if (acc.plain === undefined) acc.plain = chunk;
  }
}

/**
 * Parse one raw message (Buffer or string).
 *
 * @param {Buffer|string} raw
 * @returns {ParsedMail}
 */
export function parseMessage(raw) {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ''), 'utf8');
  // Normalise line endings once: every later step (header folding, multipart
  // boundaries, quoted-printable soft breaks) then only deals with '\n'.
  const text = bytes.toString('latin1').replace(/\r\n?/g, '\n');
  const parts = splitHeaderBody(text);
  const headers = parseHeaders(parts.header);

  const subject = decodeWords(headers.subject ?? '');
  const from = decodeWords(headers.from ?? '');
  const to = decodeWords(headers.to ?? '');
  const references = String(headers.references ?? '')
    .split(/\s+/)
    .map((entry) => entry.trim().replace(/^<|>$/g, ''))
    .filter(Boolean);

  const acc = {};
  collectText(headers, parts.body, acc);
  const hadHtml = acc.html !== undefined;
  const source = acc.plain !== undefined ? acc.plain : acc.html;
  const bodyText = source === undefined
    ? ''
    : (acc.plain !== undefined ? source : htmlToText(source));

  return {
    headers,
    from,
    fromAddress: extractAddress(from),
    to,
    subject,
    date: headers.date ?? '',
    messageId: String(headers['message-id'] ?? '').trim().replace(/^<|>$/g, ''),
    inReplyTo: String(headers['in-reply-to'] ?? '').trim().replace(/^<|>$/g, ''),
    references,
    autoSubmitted: headers['auto-submitted'] ?? '',
    text: bodyText,
    hadHtml,
  };
}

/**
 * Recognise the line that introduces a quoted reply: '在 ... 写道：',
 * 'On ... wrote:', '----- Original Message -----' or an Outlook 'From:' block.
 *
 * @param {string} line
 * @returns {boolean}
 */
function isQuoteAttribution(line) {
  const text = line.trim();
  if (text.length === 0) return false;
  if (/(?:写道|寫道)\s*[：:，,]?\s*$/.test(text)) return true;
  if (/\bOn\b[^\n]{0,200}\bwrote\s*:/i.test(text)) return true;
  if (/^[-—]{2,}\s*(?:Original Message|原始邮件|原始郵件)/i.test(text)) return true;
  if (/^From:\s.+/i.test(text)) return true;
  return false;
}

/**
 * Remove quoted replies anywhere in the body: the attribution line that
 * introduces a quote and everything after it, plus any '>'-prefixed line that
 * remains.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripQuoted(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const kept = [];
  for (const line of lines) {
    if (isQuoteAttribution(line)) break;
    if (/^\s*>/.test(line)) continue;
    kept.push(line);
  }
  return kept.join('\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}
