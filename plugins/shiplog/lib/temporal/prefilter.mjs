// Deterministic scan for date references in prose. Runs during ingest to decide which
// events enter the enrichment backlog - it never assigns a date itself.
//
// Reference kinds drive how far back an attribution may later move an event:
//   explicit  a date carrying its own year        -> trustworthy far back
//   partial   a date with no year                 -> looks precise, isn't
//   relative  "yesterday", "last Friday"          -> bounded by the words themselves

const MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const WEEKDAYS = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun';

// Tokens that turn a number pair into an identifier rather than a date: "PR 22/01".
const IDENTIFIER_PREFIX = /(?:\b(?:pr|mr|pull|issue|ticket|story|bug|task|sprint|epic|release|rev|revision|build|version|v|ver|item|wi|ab)\b[\s#:-]*|#)$/i;

const PATTERNS = [
  { kind: 'relative', re: /\b(?:yesterday|today|tonight|last\s+night|this\s+morning|this\s+afternoon|this\s+evening|over\s+the\s+weekend|earlier\s+this\s+week)\b/gi },
  { kind: 'relative', re: new RegExp(String.raw`\b(?:last|this|past|previous)\s+(?:${WEEKDAYS})\b`, 'gi') },
  { kind: 'relative', re: new RegExp(String.raw`\bon\s+(?:${WEEKDAYS})\b`, 'gi') },
  { kind: 'relative', re: /\b\d{1,3}\s+(?:day|week|month)s?\s+ago\b/gi },
  { kind: 'relative', re: /\b(?:last|past)\s+(?:week|month|fortnight)\b/gi },

  { kind: 'explicit', re: /\b\d{4}-\d{2}-\d{2}\b/g },
  { kind: 'explicit', re: /\b\d{1,2}[/\-.]\d{1,2}[/\-.]\d{4}\b/g },
  { kind: 'explicit', re: new RegExp(String.raw`\b(?:${MONTHS})\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b`, 'gi') },
  { kind: 'explicit', re: new RegExp(String.raw`\b\d{1,2}(?:st|nd|rd|th)?\s+(?:${MONTHS})\.?,?\s+\d{4}\b`, 'gi') },

  { kind: 'partial', re: /\b\d{1,2}[/\-.]\d{1,2}\b/g },
  { kind: 'partial', re: new RegExp(String.raw`\b(?:${MONTHS})\.?\s+\d{1,2}(?:st|nd|rd|th)?\b`, 'gi') },
  { kind: 'partial', re: new RegExp(String.raw`\b\d{1,2}(?:st|nd|rd|th)\s+(?:of\s+)?(?:${MONTHS})\b`, 'gi') },
  { kind: 'partial', re: /\bon\s+the\s+\d{1,2}(?:st|nd|rd|th)\b/gi },
];

const COMPLETION_VERB = /\b(?:completed?|complete|finished?|done|delivered?|deployed?|released?|merged?|shipped?|fixed?|resolved?|closed?|implemented?|started?|began|worked|working|reviewed?|raised?|created?|pushed?|tested?)\b/i;

/**
 * Removes spans where a date-like token is almost certainly not a date: code, URLs,
 * and version strings. Replaced with spaces so offsets stay aligned with the input.
 */
export function stripNonProse(text) {
  if (!text) return '';
  const blank = (m) => ' '.repeat(m.length);
  return String(text)
    .replace(/```[\s\S]*?```/g, blank)          // fenced code
    .replace(/~~~[\s\S]*?~~~/g, blank)
    .replace(/`[^`\n]*`/g, blank)               // inline code
    .replace(/^(?: {4}|\t).*$/gm, blank)        // indented code
    .replace(/\bhttps?:\/\/\S+/gi, blank)       // URLs often embed dates
    // Semver, but not a dotted date: "10.15.7" is a version, "01.22.2026" is not.
    // A four-digit component means a year, so only a v-prefix marks it as a version.
    .replace(/\bv\d+\.\d+(?:\.\d+)*(?:-[\w.]+)?\b/gi, blank)
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[\w.]+)?\b/g, blank);
}

function isIdentifierContext(haystack, index) {
  return IDENTIFIER_PREFIX.test(haystack.slice(Math.max(0, index - 24), index));
}

/**
 * Finds date references in prose.
 * Returns { hasCue, kinds, matches } where matches carry the kind and matched text.
 */
export function detectTemporalCues(text) {
  const cleaned = stripNonProse(text);
  const matches = [];
  const taken = [];

  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0;
    for (let m = re.exec(cleaned); m; m = re.exec(cleaned)) {
      const start = m.index;
      const end = start + m[0].length;
      // A stronger pattern already claimed this span (e.g. explicit beats partial).
      if (taken.some(([s, e]) => start < e && end > s)) continue;
      if (kind !== 'relative' && isIdentifierContext(cleaned, start)) continue;

      taken.push([start, end]);
      matches.push({ kind, text: m[0].trim(), index: start });
    }
  }

  matches.sort((a, b) => a.index - b.index);
  return {
    hasCue: matches.length > 0,
    kinds: [...new Set(matches.map((m) => m.kind))],
    matches,
    hasCompletionVerb: COMPLETION_VERB.test(cleaned),
  };
}

/**
 * Whether an event's text should enter the enrichment backlog.
 * A bare partial date with no completion verb nearby is the weakest signal and the
 * richest source of false positives, so it is not worth an LLM call on its own.
 */
export function shouldEnrich(text) {
  const { hasCue, kinds, hasCompletionVerb } = detectTemporalCues(text);
  if (!hasCue) return false;
  if (kinds.includes('relative') || kinds.includes('explicit')) return true;
  return hasCompletionVerb;
}

/** The weakest kind present decides the backdate allowance for the whole event. */
export function strictestKind(kinds) {
  if (kinds.includes('partial')) return 'partial';
  if (kinds.includes('relative')) return 'relative';
  return 'explicit';
}
