import test from 'node:test';
import assert from 'node:assert/strict';
import { redact, redactDeep, createLogger } from '../lib/redact.mjs';

const GITHUB_CLASSIC = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const GITHUB_FINE = 'github_pat_11ABCDEFG0abcdefghijkl_MNOPQRSTUVWXYZ0123456789abcdefghij';
const ATLASSIAN = 'ATATT3xFfGF0abcdefghijklmnopqrstuvwxyz0123456789ABCDEF';

test('GitHub tokens are redacted', () => {
  const out = redact(`failed with token ${GITHUB_CLASSIC} on repo`);
  assert.ok(!out.includes('ABCDEFGHIJKLMNOP'));
  assert.match(out, /ghp_\[redacted\]/);
});

test('fine-grained GitHub tokens are redacted', () => {
  const out = redact(`Authorization: Bearer ${GITHUB_FINE}`);
  assert.ok(!out.includes('MNOPQRSTUVWXYZ'));
});

test('Atlassian API tokens are redacted', () => {
  const out = redact(`jira auth ${ATLASSIAN} rejected`);
  assert.ok(!out.includes('abcdefghijklmnop'));
  assert.match(out, /ATATT\[redacted\]/);
});

test('Authorization headers are redacted regardless of scheme', () => {
  assert.match(redact('Bearer abcdef1234567890abcdef'), /Bearer \[redacted\]/);
  assert.match(redact('Basic dXNlcjpwYXNzd29yZDEyMzQ='), /Basic \[redacted\]/);
});

test('key-value secrets are redacted', () => {
  for (const line of [
    'token=super-secret-value-here',
    'password: hunter2hunter2',
    'api_key = abc123def456',
    'SHIPLOG_ADO_PAT="52characterlongpersonalaccesstokenvalue"',
  ]) {
    const out = redact(line);
    assert.match(out, /\[redacted\]/, line);
  }
});

test('a long opaque blob is redacted even without a labelling key', () => {
  const blob = 'a'.repeat(72);
  assert.ok(!redact(`request body ${blob}`).includes(blob));
});

test('ordinary log text is left readable', () => {
  const line = 'github: 12 authored PRs, 3 reviewed, 0 commits in 1.4s';
  assert.equal(redact(line), line);
});

test('URLs and identifiers survive redaction', () => {
  const line = 'fetched https://api.github.com/repos/octo/payments/pulls/42';
  assert.equal(redact(line), line);
});

test('redactDeep walks nested structures', () => {
  const out = redactDeep({
    source: 'github',
    headers: { authorization: `Bearer ${GITHUB_CLASSIC}` },
    attempts: [{ token: GITHUB_CLASSIC }, 'plain text'],
  });
  const json = JSON.stringify(out);
  assert.ok(!json.includes('ABCDEFGHIJKLMNOP'));
  assert.ok(json.includes('github'));
  assert.ok(json.includes('plain text'));
});

test('redactDeep survives circular references', () => {
  const node = { name: 'a' };
  node.self = node;
  assert.deepEqual(redactDeep(node), { name: 'a', self: '[circular]' });
});

test('the logger redacts and timestamps every line', () => {
  const lines = [];
  const log = createLogger({ write: (l) => lines.push(l), now: () => new Date('2026-08-31T22:00:00Z') });

  log.info('starting sync');
  log.error('auth failed for', { token: GITHUB_CLASSIC });

  assert.equal(lines[0], '2026-08-31T22:00:00.000Z INFO starting sync\n');
  assert.match(lines[1], /^2026-08-31T22:00:00\.000Z ERROR auth failed for/);
  assert.ok(!lines[1].includes('ABCDEFGHIJKLMNOP'), 'a token passed as an object must still be redacted');
});
