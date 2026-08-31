import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultConfig, validateConfig, loadConfig, loadSecrets, resolveToken,
  assertSecureMode, enabledSources, initialBackfillStart, syncWindowStart, detectDateFormat,
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
  const cfg = defaultConfig();
  process.env.SHIPLOG_GITHUB_TOKEN = 'from-environment';
  try {
    assert.equal(resolveToken(cfg, 'github', {}), 'from-environment');
    assert.equal(resolveToken(cfg, 'github', { SHIPLOG_GITHUB_TOKEN: 'from-file' }), 'from-file');
  } finally {
    delete process.env.SHIPLOG_GITHUB_TOKEN;
  }
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

test('the first backfill defaults to the fiscal year start', () => {
  const cfg = { ...defaultConfig(), timezone: 'Asia/Kolkata', fiscalYearStartMonth: 4 };
  const start = initialBackfillStart(cfg, new Date('2026-08-31T12:00:00Z'));
  assert.equal(start, '2026-03-31T18:30:00.000Z');   // 1 April local midnight in IST
});

test('the backfill start accepts any range expression', () => {
  const cfg = { ...defaultConfig(), timezone: 'UTC', sync: { initialBackfillFrom: '2025-01-01' } };
  assert.equal(initialBackfillStart(cfg, new Date('2026-08-31T12:00:00Z')), '2025-01-01T00:00:00.000Z');
});

test('the sync window overlaps the previous watermark by lookbackHours', () => {
  const cfg = { ...defaultConfig(), sync: { lookbackHours: 48, initialBackfillFrom: 'fy-start' } };
  const start = syncWindowStart(cfg, '2026-08-31T00:00:00.000Z');
  assert.equal(start, '2026-08-29T00:00:00.000Z');
});

test('with no watermark the sync window falls back to the backfill start', () => {
  const cfg = { ...defaultConfig(), timezone: 'UTC', fiscalYearStartMonth: 1 };
  const start = syncWindowStart(cfg, null, new Date('2026-08-31T12:00:00Z'));
  assert.equal(start, '2026-01-01T00:00:00.000Z');
});
