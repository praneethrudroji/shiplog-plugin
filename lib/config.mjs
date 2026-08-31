import { readFileSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveRange } from './ranges.mjs';

export const CONFIG_VERSION = 1;
const SOURCES = ['github', 'azure_devops', 'jira'];

export function worklogHome() {
  return process.env.WORKLOG_HOME || join(homedir(), '.worklog');
}

export const paths = (home = worklogHome()) => ({
  home,
  config: join(home, 'config.json'),
  secrets: join(home, 'secrets.env'),
  db: join(home, 'worklog.db'),
  backups: join(home, 'backups'),
  logs: join(home, 'logs'),
  lock: join(home, 'sync.lock'),
  wrapper: join(home, 'run_sync.sh'),
});

export function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    timezone: detectTimezone(),
    dateFormat: detectDateFormat(),
    weekStartsOn: 1,
    weekendDays: [0, 6],
    fiscalYearStartMonth: 4,
    fiscalYearNaming: 'start_year',
    identity: {},
    sources: {
      github: { enabled: false, useGhCli: true, tokenEnv: 'WORKLOG_GITHUB_TOKEN', orgs: [], includeCommits: false },
      azure_devops: { enabled: false, orgUrl: '', projects: [], tokenEnv: 'WORKLOG_ADO_PAT', includeDeployments: true },
      jira: { enabled: false, deployment: 'cloud', baseUrl: '', email: '', tokenEnv: 'WORKLOG_JIRA_TOKEN', projects: [] },
    },
    sync: { lookbackHours: 48, initialBackfillFrom: 'fy-start', maxBodyChars: 2000 },
    enrich: {
      enabled: true,
      // A tier alias, not a pinned snapshot ID: Claude Code resolves 'haiku' to
      // whatever model currently fills that tier, so this survives model retirement
      // with no config change. See docs/DECISIONS.md D9.
      model: 'haiku',
      fallbackModel: 'sonnet',
      confidenceFloor: 0.6,
      batchSize: 50,
      backdateDays: { explicit: 366, relative: 14, partial: 90 },
    },
    backup: { retentionDays: 30 },
    schedule: { type: 'daily', hour: 2, minute: 0 },
    standup: { enabled: false, range: 'last_working_day' },
  };
}

/** The OS locale's date order, used only as a setup-time proposal the user confirms. */
export function detectDateFormat(locale = Intl.DateTimeFormat().resolvedOptions().locale) {
  const parts = new Intl.DateTimeFormat(locale).formatToParts(new Date(2026, 0, 22));
  for (const p of parts) {
    if (p.type === 'day') return 'DMY';
    if (p.type === 'month') return 'MDY';
    if (p.type === 'year') return 'YMD';
  }
  return 'DMY';
}

export function detectTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function fail(message) {
  const err = new Error(message);
  err.code = 'WORKLOG_CONFIG';
  throw err;
}

/**
 * Config and secrets hold access to the user's work history, so a world- or
 * group-readable file is treated as a setup error rather than a warning.
 */
export function assertSecureMode(path) {
  if (process.platform === 'win32' || !existsSync(path)) return;
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) {
    fail(`${path} is mode ${mode.toString(8)}; it must not be readable by others. Run: chmod 600 ${path}`);
  }
}

export function validateConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') fail('config must be a JSON object');
  if (cfg.version !== CONFIG_VERSION) {
    fail(`config version ${cfg.version} is not supported (expected ${CONFIG_VERSION})`);
  }
  const m = cfg.fiscalYearStartMonth;
  if (!Number.isInteger(m) || m < 1 || m > 12) fail('fiscalYearStartMonth must be an integer 1-12');
  if (!['start_year', 'end_year'].includes(cfg.fiscalYearNaming)) {
    fail("fiscalYearNaming must be 'start_year' or 'end_year'");
  }
  if (!['DMY', 'MDY', 'YMD'].includes(cfg.dateFormat)) fail("dateFormat must be 'DMY', 'MDY' or 'YMD'");
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: cfg.timezone });
  } catch {
    fail(`unknown timezone: ${cfg.timezone}`);
  }
  for (const name of Object.keys(cfg.sources ?? {})) {
    if (!SOURCES.includes(name)) fail(`unknown source '${name}' (expected one of ${SOURCES.join(', ')})`);
  }
  if (cfg.sources?.jira?.enabled && !['cloud', 'server'].includes(cfg.sources.jira.deployment)) {
    fail("jira.deployment must be 'cloud' or 'server'");
  }
  const floor = cfg.enrich?.confidenceFloor;
  if (cfg.enrich?.enabled && (typeof floor !== 'number' || floor < 0 || floor > 1)) {
    fail('enrich.confidenceFloor must be a number between 0 and 1');
  }
  const standupRanges = ['last_working_day', 'last_week', 'last_month'];
  if (cfg.standup?.enabled && !standupRanges.includes(cfg.standup.range)) {
    fail(`standup.range must be one of ${standupRanges.join(', ')}`);
  }
  return cfg;
}

export function loadConfig({ home = worklogHome(), checkPermissions = true } = {}) {
  const p = paths(home);
  if (!existsSync(p.config)) {
    fail(`no config at ${p.config}. Run /worklog-setup first.`);
  }
  if (checkPermissions) assertSecureMode(p.config);

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(p.config, 'utf8'));
  } catch (err) {
    fail(`${p.config} is not valid JSON: ${err.message}`);
  }
  // Defaults fill in fields added by later versions so an older config still loads.
  const cfg = { ...defaultConfig(), ...parsed };
  cfg.sources = { ...defaultConfig().sources, ...(parsed.sources ?? {}) };
  return validateConfig(cfg);
}

/** Parses `secrets.env`; shell `export` prefixes and quotes are tolerated. */
export function loadSecrets({ home = worklogHome(), checkPermissions = true } = {}) {
  const p = paths(home);
  if (!existsSync(p.secrets)) return {};
  if (checkPermissions) assertSecureMode(p.secrets);

  const out = {};
  for (const line of readFileSync(p.secrets, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).replace(/^export\s+/, '').trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/** Secrets file wins over the ambient environment, since launchd sources it explicitly. */
export function resolveToken(cfg, source, secrets = loadSecrets()) {
  const envName = cfg.sources?.[source]?.tokenEnv;
  if (!envName) return null;
  return secrets[envName] ?? process.env[envName] ?? null;
}

export function enabledSources(cfg) {
  return SOURCES.filter((s) => cfg.sources?.[s]?.enabled);
}

/**
 * How far back the very first sync reaches. `fy-start` tracks the configured fiscal
 * year rather than a hardcoded date; nothing here limits what can later be queried.
 */
export function initialBackfillStart(cfg, now = new Date()) {
  const setting = cfg.sync?.initialBackfillFrom ?? 'fy-start';
  if (setting === 'fy-start') {
    return resolveRange('this_fy', {
      now,
      timeZone: cfg.timezone,
      fiscalYearStartMonth: cfg.fiscalYearStartMonth,
      fiscalYearNaming: cfg.fiscalYearNaming,
    }).start;
  }
  return resolveRange(setting, {
    now,
    timeZone: cfg.timezone,
    fiscalYearStartMonth: cfg.fiscalYearStartMonth,
    fiscalYearNaming: cfg.fiscalYearNaming,
  }).start;
}

/** The window a run should pull: the watermark minus an overlap, or the backfill start. */
export function syncWindowStart(cfg, lastCursor, now = new Date()) {
  if (!lastCursor) return initialBackfillStart(cfg, now);
  const lookbackMs = (cfg.sync?.lookbackHours ?? 48) * 3_600_000;
  return new Date(Date.parse(lastCursor) - lookbackMs).toISOString();
}

export function rangeOptions(cfg, now = new Date()) {
  return {
    now,
    timeZone: cfg.timezone,
    fiscalYearStartMonth: cfg.fiscalYearStartMonth,
    fiscalYearNaming: cfg.fiscalYearNaming,
    weekStartsOn: cfg.weekStartsOn ?? 1,
    weekendDays: cfg.weekendDays ?? [0, 6],
  };
}
