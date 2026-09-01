import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultConfig, validateConfig, loadConfig, loadSecrets, resolveToken, ghAuthToken,
  assertSecureMode, enabledSources, initialBackfillStart, syncWindowStart, detectDateFormat,
  assertSupportedNode,
} from '../lib/config.mjs';

function tempHome(t, { config, secrets, configMode = 0o600, secretsMode = 0o600 } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'shiplog-cfg-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  if (config !== undefined) {
    const path = join(home, 'config.json');
    writeFileSync(path, typeof config === 'string' ? config : JSON.stringify(config));
    chmodSync(path, configMode);
  }
  if (secrets !== undefined) {
    const path = join(home, 'secrets.env');
    writeFileSync(path, secrets);
    chmodSync(path, secretsMode);
  }
  return home;
}

test('the default config validates', () => {
  assert.doesNotThrow(() => validateConfig(defaultConfig()));
});

test('date format is detected from locale', () => {
  assert.equal(detectDateFormat('en-GB'), 'DMY');
  assert.equal(detectDateFormat('en-US'), 'MDY');
  assert.equal(detectDateFormat('en-IN'), 'DMY');
});

test('invalid config values are rejected with a usable message', () => {
  const bad = (over) => () => validateConfig({ ...defaultConfig(), ...over });
  assert.throws(bad({ fiscalYearStartMonth: 0 }), /1-12/);
  assert.throws(bad({ fiscalYearStartMonth: 13 }), /1-12/);
  assert.throws(bad({ fiscalYearNaming: 'whenever' }), /start_year/);
  assert.throws(bad({ timezone: 'Mars/Olympus' }), /unknown timezone/);
  assert.throws(bad({ dateFormat: 'DDMMYY' }), /dateFormat/);
  assert.throws(bad({ version: 99 }), /not supported/);
});

test('an unknown source name is rejected rather than silently ignored', () => {
  const cfg = defaultConfig();
  cfg.sources.gitlab = { enabled: true };
  assert.throws(() => validateConfig(cfg), /unknown source 'gitlab'/);
});

test('jira deployment type is required to be cloud or server when enabled', () => {
  const cfg = defaultConfig();
  cfg.sources.jira = { ...cfg.sources.jira, enabled: true, deployment: 'onprem' };
  assert.throws(() => validateConfig(cfg), /cloud.*server/);
});

test('a missing config points the user at setup', (t) => {
  const home = tempHome(t);
  assert.throws(() => loadConfig({ home }), /Run \/shiplog-setup/);
});

test('a world-readable config is a hard error', { skip: process.platform === 'win32' }, (t) => {
  const home = tempHome(t, { config: defaultConfig(), configMode: 0o644 });
  assert.throws(() => loadConfig({ home }), /must not be readable by others/);
});

test('malformed JSON reports the file and the parse error', (t) => {
  const home = tempHome(t, { config: '{ not json' });
  assert.throws(() => loadConfig({ home }), /is not valid JSON/);
});

test('a partial config is filled in from defaults', (t) => {
  const home = tempHome(t, {
    config: { version: 1, timezone: 'Asia/Kolkata', fiscalYearStartMonth: 4 },
  });
  const cfg = loadConfig({ home });
  assert.equal(cfg.fiscalYearNaming, 'start_year');
  assert.equal(cfg.sync.lookbackHours, 48);
  assert.equal(cfg.enrich.backdateDays.relative, 14);
  assert.ok(cfg.sources.github, 'source defaults should be present');
});

test('secrets parse with export prefixes and quotes', (t) => {
  const home = tempHome(t, {
    config: defaultConfig(),
    secrets: [
      '# a comment',
      '',
      'export SHIPLOG_GITHUB_TOKEN="ghp_example"',
      "SHIPLOG_JIRA_TOKEN='jira-token'",
      'SHIPLOG_ADO_PAT=plain-pat',
      'malformed line without equals',
    ].join('\n'),
  });
  const secrets = loadSecrets({ home });
  assert.equal(secrets.SHIPLOG_GITHUB_TOKEN, 'ghp_example');
  assert.equal(secrets.SHIPLOG_JIRA_TOKEN, 'jira-token');
  assert.equal(secrets.SHIPLOG_ADO_PAT, 'plain-pat');
});

test('a world-readable secrets file is a hard error', { skip: process.platform === 'win32' }, (t) => {
  const home = tempHome(t, { config: defaultConfig(), secrets: 'A=b', secretsMode: 0o640 });
  assert.throws(() => loadSecrets({ home }), /must not be readable by others/);
});

test('a missing secrets file is not an error', (t) => {
  const home = tempHome(t, { config: defaultConfig() });
  assert.deepEqual(loadSecrets({ home }), {});
});

test('the secrets file takes precedence over the ambient environment', () => {
  // useGhCli defaults true and is checked first; disabled here so this test
  // exercises the tokenEnv path specifically, regardless of whether gh happens to
  // be installed and logged in on the machine running the suite.
  const cfg = defaultConfig();
  cfg.sources.github.useGhCli = false;
  process.env.SHIPLOG_GITHUB_TOKEN = 'from-environment';
  try {
    assert.equal(resolveToken(cfg, 'github', {}), 'from-environment');
    assert.equal(resolveToken(cfg, 'github', { SHIPLOG_GITHUB_TOKEN: 'from-file' }), 'from-file');
  } finally {
    delete process.env.SHIPLOG_GITHUB_TOKEN;
  }
});

test('ghAuthToken trims stdout and returns null if gh fails or is missing', () => {
  assert.equal(ghAuthToken(() => 'gho_realtoken\n'), 'gho_realtoken');
  assert.equal(ghAuthToken(() => { throw new Error('gh: command not found'); }), null);
  assert.equal(ghAuthToken(() => ''), null, 'an empty token is treated the same as none');
});

test('with useGhCli on, gh auth token is tried before tokenEnv', () => {
  const cfg = defaultConfig();
  cfg.sources.github.useGhCli = true;
  const secrets = { SHIPLOG_GITHUB_TOKEN: 'from-file' };

  assert.equal(resolveToken(cfg, 'github', secrets, () => 'gho_fromgh'), 'gho_fromgh');
  // gh not logged in (or not installed) falls back to the stored token, not null.
  assert.equal(resolveToken(cfg, 'github', secrets, () => null), 'from-file');
});

test('with useGhCli off, gh is never consulted even if injected', () => {
  const cfg = defaultConfig();
  cfg.sources.github.useGhCli = false;
  let called = false;
  resolveToken(cfg, 'github', { SHIPLOG_GITHUB_TOKEN: 'from-file' }, () => { called = true; return 'gho_x'; });
  assert.equal(called, false);
});

test('useGhCli only affects github, not other sources', () => {
  const cfg = defaultConfig();
  cfg.sources.github.useGhCli = true;
  let called = false;
  const token = resolveToken(cfg, 'azure_devops', { SHIPLOG_ADO_PAT: 'ado-token' }, () => { called = true; return 'gho_x'; });
  assert.equal(called, false, "azure_devops must not consult gh's token");
  assert.equal(token, 'ado-token');
});

test('assertSecureMode ignores files that do not exist', () => {
  assert.doesNotThrow(() => assertSecureMode('/nonexistent/shiplog/config.json'));
});

test('only enabled sources are listed', () => {
  const cfg = defaultConfig();
  cfg.sources.github.enabled = true;
  cfg.sources.jira.enabled = true;
  assert.deepEqual(enabledSources(cfg).sort(), ['github', 'jira']);
});

test('the first backfill defaults to 2 years back', () => {
  const cfg = { ...defaultConfig(), timezone: 'UTC' };
  const start = initialBackfillStart(cfg, new Date('2026-08-31T12:00:00Z'));
  // last_24_months resolves via civil-month arithmetic to a local-midnight
  // boundary, not the exact clock time 2 years ago, it lands within the
  // millisecond-based cap, so the cap itself never has to engage here.
  assert.equal(start, '2024-09-01T00:00:00.000Z');
});

test('fy-start is still available as an explicit opt-in setting', () => {
  const cfg = { ...defaultConfig(), timezone: 'Asia/Kolkata', fiscalYearStartMonth: 4, sync: { initialBackfillFrom: 'fy-start' } };
  const start = initialBackfillStart(cfg, new Date('2026-08-31T12:00:00Z'));
  assert.equal(start, '2026-03-31T18:30:00.000Z');   // 1 April local midnight in IST
});

test('the backfill start accepts any range expression, within the 2-year cap', () => {
  const cfg = { ...defaultConfig(), timezone: 'UTC', sync: { initialBackfillFrom: '2025-01-01' } };
  assert.equal(initialBackfillStart(cfg, new Date('2026-08-31T12:00:00Z')), '2025-01-01T00:00:00.000Z');
});

// The cap is a hard ceiling, not a config field: nothing the user sets, including a
// future config default nobody has reconsidered, can make the first sync reach
// back further than 2 years, since GitHub's search API is rate-limited and an
// unbounded WIQL query has no natural lower bound.

test('all_time is clamped to 2 years back, not left unbounded', () => {
  const cfg = { ...defaultConfig(), timezone: 'UTC', sync: { initialBackfillFrom: 'all_time' } };
  const start = initialBackfillStart(cfg, new Date('2026-08-31T12:00:00Z'));
  assert.equal(start, '2024-08-31T12:00:00.000Z', 'must not resolve all the way to 1970');
});

test('an explicit date far older than 2 years is clamped the same way', () => {
  const cfg = { ...defaultConfig(), timezone: 'UTC', sync: { initialBackfillFrom: '2015-01-01' } };
  const start = initialBackfillStart(cfg, new Date('2026-08-31T12:00:00Z'));
  assert.equal(start, '2024-08-31T12:00:00.000Z');
});

test('a setting already within the cap is never pulled forward', () => {
  const cfg = { ...defaultConfig(), timezone: 'UTC', sync: { initialBackfillFrom: 'last_3_months' } };
  const start = initialBackfillStart(cfg, new Date('2026-08-31T12:00:00Z'));
  assert.equal(start, '2026-06-01T00:00:00.000Z', 'a shorter window must pass through untouched');
});

test('the sync window overlaps the previous watermark by lookbackHours', () => {
  const cfg = { ...defaultConfig(), sync: { lookbackHours: 48, initialBackfillFrom: 'fy-start' } };
  const start = syncWindowStart(cfg, '2026-08-31T00:00:00.000Z');
  assert.equal(start, '2026-08-29T00:00:00.000Z');
});

test('with no watermark the sync window falls back to the (capped) backfill start', () => {
  const cfg = { ...defaultConfig(), timezone: 'UTC', sync: { initialBackfillFrom: 'fy-start' }, fiscalYearStartMonth: 1 };
  const start = syncWindowStart(cfg, null, new Date('2026-08-31T12:00:00Z'));
  assert.equal(start, '2026-01-01T00:00:00.000Z');
});

test('assertSupportedNode accepts the documented floor and anything newer', () => {
  assert.doesNotThrow(() => assertSupportedNode('22.0.0'));
  assert.doesNotThrow(() => assertSupportedNode('24.1.0'));
  assert.doesNotThrow(() => assertSupportedNode('26.8.1'));
});

test('assertSupportedNode rejects anything older, with a clear reason', () => {
  assert.throws(() => assertSupportedNode('20.11.0'), /Node\.js 22 or later \(found 20\.11\.0\)/);
  assert.throws(() => assertSupportedNode('18.19.0'), /node:sqlite/);
});

test('the running test process itself satisfies the floor', () => {
  // The most direct check there is: if this assertion fails, the suite could not
  // have started at all, since lib/config.mjs runs this at import time.
  assert.doesNotThrow(() => assertSupportedNode());
});
