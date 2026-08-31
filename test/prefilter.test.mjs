import test from 'node:test';
import assert from 'node:assert/strict';
import { detectTemporalCues, shouldEnrich, stripNonProse, strictestKind } from '../lib/temporal/prefilter.mjs';

const kindsOf = (s) => detectTemporalCues(s).kinds.sort();
const textsOf = (s) => detectTemporalCues(s).matches.map((m) => m.text.toLowerCase());

test('relative day references are detected', () => {
  for (const phrase of ['Yesterday I completed the migration', 'finished this today', 'deployed last night', 'wrapped it up this morning', 'worked on it over the weekend']) {
    assert.ok(detectTemporalCues(phrase).hasCue, phrase);
    assert.deepEqual(kindsOf(phrase), ['relative'], phrase);
  }
});

test('weekday references are detected', () => {
  for (const phrase of ['completed last Friday', 'On Tuesday I fixed the bug', 'this Wednesday', 'past Monday']) {
    assert.deepEqual(kindsOf(phrase), ['relative'], phrase);
  }
});

test('elapsed-time references are detected', () => {
  assert.deepEqual(kindsOf('finished it 3 days ago'), ['relative']);
  assert.deepEqual(kindsOf('deployed 2 weeks ago'), ['relative']);
  assert.deepEqual(kindsOf('done last week'), ['relative']);
});

test('explicit dates carrying a year are classified as explicit', () => {
  for (const phrase of ['completed on 22/01/2026', 'done 2026-01-22', 'shipped Jan 22, 2026', 'finished 22nd January 2026', 'merged on 01.22.2026']) {
    assert.deepEqual(kindsOf(phrase), ['explicit'], phrase);
  }
});

test('dates without a year are classified as partial', () => {
  for (const phrase of ['completed on 22/01', 'finished Jan 22', 'done on the 5th', 'delivered 22nd of January']) {
    assert.deepEqual(kindsOf(phrase), ['partial'], phrase);
  }
});

test('an explicit date is not double-counted as a partial one', () => {
  const cues = detectTemporalCues('finished on 22/01/2026');
  assert.equal(cues.matches.length, 1, 'overlapping weaker match must be suppressed');
  assert.equal(cues.matches[0].kind, 'explicit');
});

test('plain prose with no date reference produces no cue', () => {
  for (const phrase of ['Fixed the null pointer in the payment client', 'LGTM, nice work', 'Rebased onto main and resolved conflicts', '']) {
    assert.equal(detectTemporalCues(phrase).hasCue, false, phrase);
  }
});

// The negative cases below are the whole point of the guard: a wrong attribution is
// worse than a missing one.

test('identifier references are not read as dates', () => {
  for (const phrase of ['see PR 22/01', 'fixed in #22/01', 'part of sprint 22/01', 'tracked in ticket 12/05', 'release 10/2025', 'build 3/4']) {
    assert.equal(detectTemporalCues(phrase).hasCue, false, phrase);
  }
});

test('version strings are not read as dates', () => {
  for (const phrase of ['bumped to v1.2.3', 'upgraded to 10.15.7', 'now on v2.0.1-beta']) {
    assert.equal(detectTemporalCues(phrase).hasCue, false, phrase);
  }
});

test('dates inside code blocks are ignored', () => {
  const fenced = 'Fixed the parser:\n```js\nconst d = "2026-01-22";\n```\nAll good.';
  assert.equal(detectTemporalCues(fenced).hasCue, false);

  const inline = 'Set the default to `2026-01-22` in config.';
  assert.equal(detectTemporalCues(inline).hasCue, false);

  const indented = 'Example:\n\n    released 2026-01-22\n\ndone.';
  assert.equal(detectTemporalCues(indented).hasCue, false);
});

test('dates inside URLs are ignored', () => {
  assert.equal(detectTemporalCues('see https://blog.test/2026/01/22/post for context').hasCue, false);
});

test('a real date alongside a code block is still found', () => {
  const mixed = 'Yesterday I fixed this:\n```\nversion = "2020-01-01"\n```';
  const cues = detectTemporalCues(mixed);
  assert.deepEqual(cues.kinds, ['relative']);
  assert.deepEqual(textsOf(mixed), ['yesterday']);
});

test('stripNonProse preserves offsets so match positions stay meaningful', () => {
  const input = 'a `code` b';
  assert.equal(stripNonProse(input).length, input.length);
  assert.equal(stripNonProse(input), 'a        b');
});

test('shouldEnrich accepts strong signals regardless of verb', () => {
  assert.equal(shouldEnrich('yesterday'), true);
  assert.equal(shouldEnrich('2026-01-22'), true);
});

test('shouldEnrich requires a completion verb for a bare partial date', () => {
  assert.equal(shouldEnrich('moved to 22/01'), false, 'no completion verb -> not worth a call');
  assert.equal(shouldEnrich('completed on 22/01'), true);
  assert.equal(shouldEnrich('finished Jan 22'), true);
});

test('shouldEnrich rejects text with no cue at all', () => {
  assert.equal(shouldEnrich('Completed the refactor'), false, 'a verb alone is not a date');
  assert.equal(shouldEnrich(''), false);
  assert.equal(shouldEnrich(null), false);
});

test('the weakest reference kind governs the backdate allowance', () => {
  assert.equal(strictestKind(['explicit']), 'explicit');
  assert.equal(strictestKind(['relative']), 'relative');
  assert.equal(strictestKind(['explicit', 'partial']), 'partial');
  assert.equal(strictestKind(['relative', 'explicit']), 'relative');
});

test('a realistic standup comment is flagged with its cue extracted', () => {
  const body = 'Yesterday I completed the payment migration and deployed it to staging. Today I am picking up the retry logic.';
  const cues = detectTemporalCues(body);
  assert.equal(cues.hasCue, true);
  assert.equal(cues.hasCompletionVerb, true);
  assert.deepEqual(textsOf(body), ['yesterday', 'today']);
});
