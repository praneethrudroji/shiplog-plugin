// Log lines from an unattended job end up in a file the user may paste into a bug
// report. Tokens must never reach that file, so redaction happens at the sink rather
// than relying on every call site to remember.

const PATTERNS = [
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, 'ghp_[redacted]'],              // GitHub classic
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_[redacted]'],     // GitHub fine-grained
  [/\bATATT[A-Za-z0-9_\-=]{20,}/g, 'ATATT[redacted]'],              // Atlassian API token
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, 'glpat-[redacted]'],
  // The key may be a prefixed identifier such as WORKLOG_ADO_PAT, where `_` prevents
  // a word boundary before the secret-ish suffix.
  [/([A-Za-z0-9_.-]*(?:authorization|token|pat|password|passwd|secret|api[_-]?key))(\s*[:=]\s*)("?)\S+?\3(?=[\s,;}]|$)/gi,
    (_m, key, sep) => `${key}${sep}[redacted]`],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9+/_.~-]{8,}={0,2}/g, '$1 [redacted]'],
  [/\b[A-Za-z0-9+/]{60,}={0,2}\b/g, '[redacted]'],                  // long opaque blobs
];

export function redact(value) {
  let text = typeof value === 'string' ? value : String(value ?? '');
  for (const [re, replacement] of PATTERNS) text = text.replace(re, replacement);
  return text;
}

/** Redacts every string inside a structure, for logging error objects and payloads. */
export function redactDeep(value, seen = new WeakSet()) {
  if (typeof value === 'string') return redact(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, seen));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, seen)]));
}

export function createLogger({ write = (line) => process.stderr.write(line), now = () => new Date() } = {}) {
  const emit = (level, parts) => {
    const message = parts
      .map((p) => (typeof p === 'string' ? p : JSON.stringify(redactDeep(p))))
      .join(' ');
    write(`${now().toISOString()} ${level} ${redact(message)}\n`);
  };
  return {
    info: (...parts) => emit('INFO', parts),
    warn: (...parts) => emit('WARN', parts),
    error: (...parts) => emit('ERROR', parts),
  };
}
