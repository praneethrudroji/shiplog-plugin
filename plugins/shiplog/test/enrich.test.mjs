import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, upsertEvents, pendingEnrichment } from '../lib/db.mjs';
import { defaultConfig } from '../lib/config.mjs';
import { parseAttributions, validateAttribution, buildPrompt, enrichPending } from '../lib/temporal/enrich.mjs';

function tempDb(t) {
  const dir = mkdtempSync(join(tmpdir(), 'shiplog-enrich-'));
  const db = openDatabase(join(dir, 'test.db'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return db;
}

function cfg(over = {}) {
  const c = defaultConfig();
  c.timezone = 'UTC';
  c.enrich = { ...c.enrich, enabled: true, model: 'haiku', fallbackModel: 'sonnet', confidenceFloor: 0.6, batchSize: 50, backdateDays: { explicit: 366, relative: 14, partial: 90 } };
  return { ...c, ...over };
}

const ev = (over) => ({
  source: 'github', event_type: 'pr_comment', external_id: `x-${Math.random()}`,
  title: null, body: 'Yesterday I finished the retry logic.', occurred_at: '2026-08-31T09:00:00.000Z',
  raw_json: {}, synced_at: '2026-08-31T22:00:00.000Z', needs_enrichment: 1, ...over,
});

// --- parseAttributions -----------------------------------------------------

test('parses a clean JSON array', () => {
  const arr = [{ event_id: 1, effective_date: '2026-08-30', confidence: 0.9 }];
  assert.deepEqual(parseAttributions(JSON.stringify(arr)), arr);
});

test('strips a markdown code fence, which the model adds despite instructions', () => {
  const arr = [{ event_id: 1, effective_date: '2026-08-30', confidence: 0.9 }];
  const fenced = `\`\`\`json\n${JSON.stringify(arr)}\n\`\`\``;
  assert.deepEqual(parseAttributions(fenced), arr);
});

test('extracts a bracketed array from surrounding prose as a last resort', () => {
  const arr = [{ event_id: 1, effective_date: '2026-08-30', confidence: 0.9 }];
  const withProse = `Here is the result:\n${JSON.stringify(arr)}\nLet me know if you need anything else.`;
  assert.deepEqual(parseAttributions(withProse), arr);
});

test('throws rather than fabricating a result when nothing parses', () => {
  assert.throws(() => parseAttributions('I could not determine any dates.'), /parseable JSON array/);
  assert.throws(() => parseAttributions('{"not": "an array"}'), /parseable JSON array/);
});

// --- validateAttribution: the backdate guard --------------------------------

const base = { postedDate: '2026-08-31', today: '2026-08-31', backdateDays: { explicit: 366, relative: 14, partial: 90 } };

test('an explicit date is trusted far back', () => {
  const attr = { effective_date: '2026-02-01', confidence: 0.9 };
  assert.equal(validateAttribution(attr, { ...base, kind: 'explicit' }).ok, true);
});

test('a relative phrase is capped at 14 days back', () => {
  const ok = { effective_date: '2026-08-18', confidence: 0.9 };   // 13 days back
  const tooFar = { effective_date: '2026-08-10', confidence: 0.9 };   // 21 days back
  assert.equal(validateAttribution(ok, { ...base, kind: 'relative' }).ok, true);
  const rejected = validateAttribution(tooFar, { ...base, kind: 'relative' });
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /exceeds the 14d limit/);
});

test('a partial date is capped at 90 days and still needs confidence', () => {
  const tooFar = { effective_date: '2026-01-01', confidence: 0.9 };
  assert.equal(validateAttribution(tooFar, { ...base, kind: 'partial' }).ok, false);
});

test('a future date is always rejected regardless of kind', () => {
  const attr = { effective_date: '2026-09-15', confidence: 0.95 };
  const result = validateAttribution(attr, { ...base, kind: 'explicit' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /future/);
});

test('an attribution dated after the comment was posted is rejected', () => {
  const attr = { effective_date: '2026-09-01', confidence: 0.9 };
  const result = validateAttribution(attr, { ...base, kind: 'explicit', postedDate: '2026-08-31', today: '2026-09-05' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /after the comment was posted/);
});

test('low confidence is rejected even with a well-formed date', () => {
  const attr = { effective_date: '2026-08-30', confidence: 0.3 };
  const result = validateAttribution(attr, { ...base, kind: 'explicit', confidenceFloor: 0.6 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /confidence/);
});

test('a malformed or missing date is rejected', () => {
  assert.equal(validateAttribution({ confidence: 0.9 }, { ...base, kind: 'explicit' }).ok, false);
  assert.equal(validateAttribution({ effective_date: '30/08/2026', confidence: 0.9 }, { ...base, kind: 'explicit' }).ok, false);
});

// Regression: a live sync resolved "Last Friday" (posted Tuesday 2026-09-01) to
// 2026-08-29, which is a Saturday, accepted at 0.95 confidence by every other
// guard. A claimed weekday is a fact code can check with certainty; it must not
// depend on the model getting it right.
test('a claimed weekday that does not match the resolved date is rejected', () => {
  const attr = { effective_date: '2026-08-29', confidence: 0.95 }; // a Saturday
  const result = validateAttribution(attr, {
    ...base, kind: 'relative', postedDate: '2026-09-01', today: '2026-09-01',
    text: 'Last Friday I noticed a small typo, fixed now.',
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /says "Friday" but 2026-08-29 is a Saturday/);
});

test('a claimed weekday that does match the resolved date is accepted', () => {
  const attr = { effective_date: '2026-08-28', confidence: 0.95 }; // the actual Friday
  const result = validateAttribution(attr, {
    ...base, kind: 'relative', postedDate: '2026-09-01', today: '2026-09-01',
    text: 'Last Friday I noticed a small typo, fixed now.',
  });
  assert.equal(result.ok, true);
});

test('weekday abbreviations are recognized too', () => {
  const attr = { effective_date: '2026-08-29', confidence: 0.9 }; // a Saturday
  const result = validateAttribution(attr, {
    ...base, kind: 'relative', postedDate: '2026-09-01', today: '2026-09-01', text: 'done last Fri',
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /Friday/);
});

test('text with no weekday mention is unaffected by the weekday check', () => {
  const attr = { effective_date: '2026-08-30', confidence: 0.9 };
  const result = validateAttribution(attr, { ...base, kind: 'explicit', text: 'finished this on 22/01/2026' });
  assert.equal(result.ok, true);
});

test('a weekday mentioned in an unrelated context still gets checked (documented tradeoff)', () => {
  // "Wednesday" could describe an unrelated event mentioned in passing rather than
  // the work itself, but treating any weekday mention as a hard fact to verify is
  // the safer failure mode here: it can reject a correct attribution in a false-
  // positive case, but it can never accept a self-contradictory one.
  const attr = { effective_date: '2026-08-31', confidence: 0.9 }; // a Monday
  const result = validateAttribution(attr, {
    ...base, kind: 'relative', postedDate: '2026-09-01', today: '2026-09-01',
    text: 'Fixed the issue reported on Wednesday.',
  });
  assert.equal(result.ok, false);
});

test('an unknown kind falls back to the strictest (partial) limit', () => {
  const attr = { effective_date: '2026-01-01', confidence: 0.9 };
  const result = validateAttribution(attr, { ...base, kind: 'made_up_kind' });
  assert.equal(result.ok, false);
});

// --- buildPrompt -------------------------------------------------------------

test('the prompt includes the weekday, the posted date, and the dateFormat preference', () => {
  const items = [{ id: 1, text: 'Finished it last Friday.', postedAt: '2026-08-31T09:00:00.000Z', postedDate: '2026-08-31', timezone: 'UTC' }];
  const prompt = buildPrompt(items, { dateFormat: 'DMY' });
  assert.match(prompt, /DMY/);
  assert.match(prompt, /Monday, 2026-08-31/);
  assert.match(prompt, /Finished it last Friday\./);
  assert.match(prompt, /ONLY a JSON array/);
});

// --- enrichPending: the orchestration ---------------------------------------

test('a resolved attribution is written back and clears the backlog', async (t) => {
  const db = tempDb(t);
  upsertEvents(db, [ev({ external_id: 'a' })]);
  const { id } = pendingEnrichment(db)[0];

  const runClaude = async () => JSON.stringify([
    { event_id: id, effective_date: '2026-08-30', precision: 'day', confidence: 0.9, reasoning: '"Yesterday" relative to a 31 Aug post' },
  ]);

  const result = await enrichPending(db, cfg(), { runClaude, now: new Date('2026-08-31T22:00:00Z') });
  assert.equal(result.resolved, 1);
  assert.equal(pendingEnrichment(db).length, 0);

  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
  assert.equal(row.effective_at, '2026-08-30');
  assert.equal(row.effective_source, 'llm');
});

test('an event the model omits stays in the backlog rather than being guessed at', async (t) => {
  const db = tempDb(t);
  upsertEvents(db, [ev({ external_id: 'a', body: 'Nothing temporal here, just a status update.' })]);

  const result = await enrichPending(db, cfg(), { runClaude: async () => '[]', now: new Date('2026-08-31T22:00:00Z') });
  assert.equal(result.resolved, 0);
  assert.equal(pendingEnrichment(db).length, 1, 'must remain queued, not silently dropped');
});

test('a rejected attribution (fails validation) leaves the event in the backlog', async (t) => {
  const db = tempDb(t);
  upsertEvents(db, [ev({ external_id: 'a' })]);
  const { id } = pendingEnrichment(db)[0];

  // Confidence too low to accept.
  const runClaude = async () => JSON.stringify([{ event_id: id, effective_date: '2026-08-30', confidence: 0.2 }]);
  const result = await enrichPending(db, cfg(), { runClaude, now: new Date('2026-08-31T22:00:00Z') });

  assert.equal(result.resolved, 0);
  assert.equal(pendingEnrichment(db).length, 1);
});

test('a failed CLI invocation is caught and the backlog is preserved for the next run', async (t) => {
  const db = tempDb(t);
  upsertEvents(db, [ev({ external_id: 'a' })]);

  const runClaude = async () => { throw new Error('claude -p invocation failed: command not found'); };
  const result = await enrichPending(db, cfg(), { runClaude, now: new Date() });

  assert.equal(result.resolved, 0);
  assert.match(result.error, /invocation failed/);
  assert.equal(pendingEnrichment(db).length, 1);
});

test('an unparseable response is caught the same way', async (t) => {
  const db = tempDb(t);
  upsertEvents(db, [ev({ external_id: 'a' })]);

  const result = await enrichPending(db, cfg(), { runClaude: async () => 'not json', now: new Date() });
  assert.equal(result.resolved, 0);
  assert.equal(pendingEnrichment(db).length, 1);
});

test('an id the model invents (not among those asked about) is ignored, not written', async (t) => {
  const db = tempDb(t);
  upsertEvents(db, [ev({ external_id: 'a' })]);

  const runClaude = async () => JSON.stringify([{ event_id: 999999, effective_date: '2026-08-30', confidence: 0.9 }]);
  await enrichPending(db, cfg(), { runClaude, now: new Date('2026-08-31T22:00:00Z') });
  assert.equal(pendingEnrichment(db).length, 1, "the real pending event wasn't touched");
});

test('multiple events are resolved from a single batched call', async (t) => {
  const db = tempDb(t);
  // Distinct occurred_at values, so pendingEnrichment's ORDER BY has no tie to
  // break arbitrarily: with identical timestamps, which row comes back "first"
  // is undefined, and a fixture that maps dates positionally rather than by id
  // would attach the wrong date to the wrong event without either failing, if
  // nothing ever cross-checks the date against the text (as now happens here).
  upsertEvents(db, [
    ev({ external_id: 'a', body: 'Yesterday I finished the retry logic.', occurred_at: '2026-08-31T09:00:00.000Z' }),
    ev({ external_id: 'b', body: 'Wrapped this up last Friday.', occurred_at: '2026-08-31T10:00:00.000Z' }),
  ]);
  const pending = pendingEnrichment(db);
  const idFor = (bodyFragment) => pending.find((r) => r.body.includes(bodyFragment)).id;
  let callCount = 0;

  const runClaude = async () => {
    callCount += 1;
    return JSON.stringify([
      { event_id: idFor('Yesterday'), effective_date: '2026-08-30', confidence: 0.9 },
      { event_id: idFor('last Friday'), effective_date: '2026-08-28', confidence: 0.85 },
    ]);
  };

  const result = await enrichPending(db, cfg(), { runClaude, now: new Date('2026-08-31T22:00:00Z') });
  assert.equal(callCount, 1, 'one batched call, not one per event');
  assert.equal(result.resolved, 2);
});

test('enrichment is a no-op when disabled in config', async (t) => {
  const db = tempDb(t);
  upsertEvents(db, [ev({ external_id: 'a' })]);
  const c = cfg({ enrich: { ...cfg().enrich, enabled: false } });

  const result = await enrichPending(db, c, { runClaude: async () => { throw new Error('should not be called'); } });
  assert.deepEqual(result, { processed: 0, resolved: 0, skipped: 'disabled' });
});

test('an empty backlog makes no call at all', async (t) => {
  const db = tempDb(t);
  let called = false;
  const result = await enrichPending(db, cfg(), { runClaude: async () => { called = true; return '[]'; } });
  assert.equal(called, false);
  assert.deepEqual(result, { processed: 0, resolved: 0 });
});
