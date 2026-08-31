import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pendingEnrichment, setAttribution } from '../db.mjs';
import { zonedParts } from '../ranges.mjs';
import { detectTemporalCues, strictestKind } from './prefilter.mjs';

const execFileAsync = promisify(execFile);

const DEFAULT_BACKDATE = { explicit: 366, relative: 14, partial: 90 };
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Invokes `claude -p` as a batch classifier. Uses a capability alias for `model`
 * (e.g. 'haiku'), never a pinned model ID - see docs/DECISIONS.md § Model selection.
 */
export async function runClaudeCli({ prompt, model, fallbackModel, timeoutMs = 120_000 }) {
  const args = ['-p', prompt, '--model', model, '--output-format', 'json'];
  if (fallbackModel) args.push('--fallback-model', fallbackModel);

  let stdout;
  try {
    ({ stdout } = await execFileAsync('claude', args, { maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs }));
  } catch (err) {
    throw new Error(`claude -p invocation failed: ${err.message}`);
  }

  let outer;
  try {
    outer = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`claude -p returned non-JSON output: ${err.message}`);
  }
  if (outer.is_error) throw new Error(`claude -p reported an error (${outer.subtype ?? 'unknown'})`);
  if (typeof outer.result !== 'string') throw new Error('claude -p response had no result field');
  return outer.result;
}

function stripCodeFence(text) {
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text.trim());
  return m ? m[1] : text.trim();
}

/**
 * The model is told to return only a JSON array, but in practice sometimes wraps it
 * in a code fence or adds a stray sentence regardless. Try progressively looser
 * extraction rather than failing on the first mismatch - but never invent a result
 * if nothing parses.
 */
export function parseAttributions(resultText) {
  const candidates = [stripCodeFence(resultText)];
  const bracketed = /\[[\s\S]*\]/.exec(resultText);
  if (bracketed) candidates.push(bracketed[0]);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* try the next candidate */ }
  }
  throw new Error('response did not contain a parseable JSON array');
}

function daysBetween(laterDate, earlierDate) {
  return Math.round((Date.parse(laterDate) - Date.parse(earlierDate)) / 86_400_000);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Applies the backdate guard from docs/DECISIONS.md: the allowed distance between an
 * event's posted date and its attributed date scales with how self-dating the
 * original reference was. Rejecting a good attribution costs little - the event
 * keeps its posted date; accepting a bad one plants a wrong entry in the record.
 */
export function validateAttribution(attr, { kind, postedDate, today, backdateDays = DEFAULT_BACKDATE, confidenceFloor = 0.6 }) {
  if (!attr || typeof attr.effective_date !== 'string' || !DATE_RE.test(attr.effective_date)) {
    return { ok: false, reason: 'missing or malformed effective_date' };
  }
  if (typeof attr.confidence !== 'number' || attr.confidence < confidenceFloor) {
    return { ok: false, reason: `confidence ${attr.confidence} below floor ${confidenceFloor}` };
  }
  if (attr.effective_date > today) {
    return { ok: false, reason: 'attributed date is in the future' };
  }

  const daysBack = daysBetween(postedDate, attr.effective_date);
  if (daysBack < 0) {
    return { ok: false, reason: 'attributed after the comment was posted' };
  }
  const limit = backdateDays[kind] ?? backdateDays.partial ?? DEFAULT_BACKDATE.partial;
  if (daysBack > limit) {
    return { ok: false, reason: `${daysBack}d back exceeds the ${limit}d limit for a ${kind} reference` };
  }
  return { ok: true };
}

function describePostedTime(occurredAt, timezone) {
  const p = zonedParts(new Date(occurredAt), timezone);
  const date = `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
  return { date, weekday: WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()] };
}

export function buildPrompt(items, { dateFormat }) {
  const rows = items.map((it) => ({
    event_id: it.id,
    posted: `${describePostedTime(it.postedAt, it.timezone).weekday}, ${it.postedDate}`,
    text: it.text,
  }));

  return `You are extracting the date that work was actually completed from developer comments.

Each comment was posted on the date given. It may reference a different date using relative language
("yesterday", "last Friday") or an explicit date. The user's date-order convention is ${dateFormat}
(so in an ambiguous numeric date, read it that way).

For each comment, if - and only if - it contains a clear reference to when the work was done, return
its resolved calendar date. If a comment has no clear temporal reference, or the reference is too
vague to resolve confidently, omit that event_id entirely rather than guessing.

Return ONLY a JSON array (no other text, no markdown fence), each element shaped exactly as:
{"event_id": <number>, "effective_date": "YYYY-MM-DD", "precision": "day"|"week"|"month", "confidence": <0-1>, "reasoning": "<one short phrase>"}

Comments:
${JSON.stringify(rows, null, 2)}`;
}

/**
 * Resolves the pending attribution backlog in one batched call. Never throws for a
 * model-side or parsing failure - those are logged and the backlog simply carries to
 * the next run, which is what keeps this stage safely decoupled from ingestion.
 */
export async function enrichPending(db, cfg, { runClaude = runClaudeCli, now = new Date(), log = () => {} } = {}) {
  if (!cfg.enrich?.enabled) return { processed: 0, resolved: 0, skipped: 'disabled' };

  const pending = pendingEnrichment(db, cfg.enrich.batchSize ?? 50);
  if (!pending.length) return { processed: 0, resolved: 0 };

  const backdateDays = cfg.enrich.backdateDays ?? DEFAULT_BACKDATE;
  const items = pending.map((row) => {
    const text = row.body || row.title || '';
    const cues = detectTemporalCues(text);
    const kind = strictestKind(cues.kinds.length ? cues.kinds : ['partial']);
    return { id: row.id, text, kind, postedAt: row.occurred_at, postedDate: describePostedTime(row.occurred_at, cfg.timezone).date };
  });

  const prompt = buildPrompt(items, { dateFormat: cfg.dateFormat ?? 'DMY' });

  let resultText;
  try {
    resultText = await runClaude({ prompt, model: cfg.enrich.model ?? 'haiku', fallbackModel: cfg.enrich.fallbackModel });
  } catch (err) {
    log(`enrichment call failed, will retry next run: ${err.message}`);
    return { processed: pending.length, resolved: 0, error: err.message };
  }

  let attributions;
  try {
    attributions = parseAttributions(resultText);
  } catch (err) {
    log(`enrichment response unusable, will retry next run: ${err.message}`);
    return { processed: pending.length, resolved: 0, error: err.message };
  }

  const byId = new Map(items.map((it) => [it.id, it]));
  const today = describePostedTime(now.toISOString(), cfg.timezone).date;
  let resolved = 0;

  for (const attr of attributions) {
    const item = byId.get(attr.event_id);
    if (!item) continue;   // the model referenced an id we never asked about

    const check = validateAttribution(attr, { kind: item.kind, postedDate: item.postedDate, today, backdateDays, confidenceFloor: cfg.enrich.confidenceFloor ?? 0.6 });
    if (!check.ok) {
      log(`rejected attribution for event ${attr.event_id}: ${check.reason}`);
      continue;
    }

    setAttribution(db, attr.event_id, {
      effective_at: attr.effective_date,
      precision: attr.precision ?? 'day',
      confidence: attr.confidence,
      source: 'llm',
      reasoning: attr.reasoning ?? null,
    });
    resolved += 1;
  }

  return { processed: pending.length, resolved };
}
