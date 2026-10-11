/**
 * Markdown -> plain text for mail bodies.
 *
 * The assistant's answer is written in Markdown; a plain-text mail client shows
 * every `#`, `*` and `|` literally, which reads as noise on a phone. This
 * converts the common constructs into something readable as plain text and
 * leaves ordinary prose (and code) alone.
 */

/** `[text](url)` -> `text (url)`; `![alt](url)` -> `图片 alt (url)`. */
function stripLinks(text) {
  return text
    .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_match, alt, url) => `图片 ${alt || ''} (${url})`.trim())
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_match, label, url) => (label === url ? url : `${label} (${url})`))
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1');
}

/** Drop a leading `#{1,6} ` heading marker, keeping the heading text. */
function stripHeadings(text) {
  return text.replace(/^ {0,3}#{1,6}[ \t]+(.*?)[ \t]*#*$/gm, (_match, title) => title);
}

/** `- `, `* `, `+ ` bullets -> `• `; blockquote markers -> two-space indent. */
function stripBulletsAndQuotes(text) {
  return text
    .replace(/^(\s*)[-*+][ \t]+/gm, '$1• ')
    .replace(/^ {0,3}>[ \t]?/gm, '  ');
}

/** Emphasis markers, conservatively: `**x**`, `__x__`, `*x*`, `~~x~~`. */
function stripEmphasis(text) {
  return text
    .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    // A single `*x*` only when it is clearly emphasis, not a bullet or math.
    .replace(/(^|[\s(（]) \*([^*\n]+)\*(?=[\s)）.,，。:：!！?？]|$)/g, '$1$2');
}

/** Dotted rule and other non-content markup. */
function stripRules(text) {
  return text.replace(/^ {0,3}(?:[-*_][ \t]*){3,}$/gm, ''.padEnd(0, ' ') + '─'.repeat(24));
}

/** GFM table -> aligned plain lines without pipes-heavy decoration. */
function stripTables(text) {
  const lines = text.split('\n');
  const out = [];
  for (const line of lines) {
    const isRow = /^\s*\|.*\|\s*$/.test(line);
    if (!isRow) {
      out.push(line);
      continue;
    }
    const separator = /^\s*\|[\s:|-]+\|\s*$/.test(line);
    if (separator) continue;
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
    out.push(cells.join(' ').replace(/\s{2,}/g, '  '));
  }
  return out.join('\n');
}

/** Fenced code blocks keep the code, lose the fence and the language tag. */
function stripFences(text) {
  return text.replace(/^ {0,3}```[^\n]*\n([\s\S]*?)^ {0,3}```[ \t]*$/gm, (_match, code) => code.replace(/\s+$/, ''));
}

/** `<br>`, `<div>` and friends leak through when the model writes HTML. */
function stripHtml(text) {
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '');
}

/**
 * Rewrite Markdown as readable plain text.
 *
 * @param text - the Markdown source.
 * @returns text with markup removed, safe to paste into a mail body.
 */
export function toPlainText(text) {
  let out = String(text ?? '');
  if (out.length === 0) return out;
  out = stripFences(out);
  out = stripTables(out);
  out = stripHeadings(out);
  out = stripRules(out);
  out = stripLinks(out);
  out = stripBulletsAndQuotes(out);
  out = stripEmphasis(out);
  out = stripHtml(out);
  out = out.replace(/`([^`\n]+)`/g, '$1'); // inline code
  out = out.replace(/[ \t]+$/gm, ''); // trailing spaces (hard breaks)
  out = out.replace(/\n{3,}/g, '\n\n'); // collapse blank runs
  return out.trim();
}
