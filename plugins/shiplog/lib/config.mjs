import { readFileSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveRange } from './ranges.mjs';

export const CONFIG_VERSION = 1;
const SOURCES = ['github', 'azure_devops', 'jira'];

// The floor this project documents (README, CLAUDE.md, DECISIONS.md). `node:sqlite`
// is what actually sets the real minimum - it shipped experimental in 22.5 and its
// exact unflagged-and-stable version is what the CI matrix in D24 exists to confirm.
// If that matrix shows 22.x failing, this number (and the docs) get corrected to
// match reality rather than the other way around.
// Established by bisecting a CI matrix, not read off a changelog: 22.13, 22.14 and
// 22.15 all fail with "The requested module 'node:sqlite' does not provide an
// export named 'backup'", while 22.16 and everything above it pass. The minor
// version matters, so a major-only check would wave through the exact versions
// that break. lib/backup.mjs imports that named export at module load, so an
// older Node dies with a SyntaxError that says nothing about what to do next.
export const MIN_NODE = { major: 22, minor: 16 };

/**
 * Every bin/ entry point imports something from this module, so the check lives
 * here once rather than being repeated in each script. A version-mismatch error
 * from a bare `import { backup } from 'node:sqlite'` is opaque; this gives a clear
 * one before that import is even reached.
 */
export function assertSupportedNode(nodeVersion = process.versions.node) {
  const [major, minor] = nodeVersion.split('.').map(Number);
  const tooOld = !Number.isFinite(major) || !Number.isFinite(minor)
    || major < MIN_NODE.major
    || (major === MIN_NODE.major && minor < MIN_NODE.minor);

  if (tooOld) {
    const err = new Error(
      `shiplog requires Node.js ${MIN_NODE.major}.${MIN_NODE.minor} or later (found ${nodeVersion}). `
      + "It uses node:sqlite's backup export for database snapshots, which earlier versions "
      + "don't provide.",
    );
    err.code = 'SHIPLOG_UNSUPPORTED_NODE';
    throw err;
  }
}

assertSupportedNode();

export function shiplogHome() {
  return process.env.SHIPLOG_HOME || join(homedir(), '.shiplog');
}

export const paths = (home = shiplogHome()) => ({
  home,
  config: join(home, 'config.json'),
  secrets: join(home, 'secrets.env'),
  db: join(home, 'shiplog.db'),
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
      github: { enabled: false, useGhCli: true, tokenEnv: 'SHIPLOG_GITHUB_TOKEN', orgs: [], includeCommits: false },
      azure_devops: { enabled: false, orgUrl: '', projects: [], tokenEnv: 'SHIPLOG_ADO_PAT', includeDeployments: true },
      jira: { enabled: false, deployment: 'cloud', baseUrl: '', email: '', tokenEnv: 'SHIPLOG_JIRA_TOKEN', projects: [] },
    },
    sync: { lookbackHours: 48, initialBackfillFrom: 'last_24_months', maxBodyChars: 2000 },
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
    standup: { enabled: false, range: 'since_last_working_day' },
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
  err.code = 'SHIPLOG_CONFIG';
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
  const standupRanges = ['since_last_working_day', 'last_working_day', 'last_week', 'last_month'];
  if (cfg.standup?.enabled && !standupRanges.includes(cfg.standup.range)) {
    fail(`standup.range must be one of ${standupRanges.join(', ')}`);
  }
  return cfg;
}

export function loadConfig({ home = shiplogHome(), checkPermissions = true } = {}) {
  const p = paths(home);
  if (!existsSync(p.config)) {
    fail(`no config at ${p.config}. Run /shiplog-setup first.`);
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
export function loadSecrets({ home = shiplogHome(), checkPermissions = true } = {}) {
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

/**
 * Asks the gh CLI for its current token, so GitHub reuses the developer's existing
 * login instead of a separately stored copy. gh's token can rotate under the
 * keyring, so this is asked fresh each call rather than cached; a failure (gh
 * missing, not logged in) returns null rather than throwing, since the caller
 * always has the tokenEnv path as a fallback.
 */
export function ghAuthToken(execFn = execFileSync) {
  try {
    return execFn('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Secrets file wins over the ambient environment, since launchd sources it
 * explicitly. For GitHub with useGhCli on, `gh auth token` is tried first and a
 * stored tokenEnv value is the fallback, so a stored token still works if gh is
 * ever logged out.
 */
export function resolveToken(cfg, source, secrets = loadSecrets(), getGhToken = ghAuthToken) {
  if (source === 'github' && cfg.sources?.github?.useGhCli) {
    const ghToken = getGhToken();
    if (ghToken) return ghToken;
  }
  const envName = cfg.sources?.[source]?.tokenEnv;
  if (!envName) return null;
  return secrets[envName] ?? process.env[envName] ?? null;
}

export function enabledSources(cfg) {
  return SOURCES.filter((s) => cfg.sources?.[s]?.enabled);
}

/**
 * How far back the very first sync reaches. `fy-start` tracks the configured fiscal
 * year rather than a hardcoded date. This bounds only the first sync; nothing here
 * limits what can later be queried, which is unrestricted.
 *
 * The result is also capped at 2 years back, independent of what
 * `initialBackfillFrom` resolves to: GitHub's search API is rate-limited and Azure
 * DevOps's WIQL query has no natural lower bound, so an unbounded or multi-year
 * setting (all_time, an old explicit date, a future default nobody has
 * reconsidered) could turn a first sync into a very long one for data that mostly
 * won't get used anyway. See D23. This is a floor on the resolved date, not a
 * config field: nothing the user sets can reach further back than this, only less
 * far.
 *
 * The cap is expressed as `resolveRange('last_24_months', ...)`, the exact same
 * calendar arithmetic that computes the default itself, rather than a fixed day
 * count. A day count is wrong here: 24 civil months spanning a leap day is 731
 * days, not 730, so a millisecond-based cap would occasionally clamp the default
 * when it should not, and land on a mid-day boundary instead of local midnight,
 * silently dropping several hours of the first sync's earliest data forever (the
 * watermark advances past whatever the first run actually covered). Reusing the
 * same calendar function the default is defined in terms of means the two are
 * identical whenever no explicit setting is given, so the cap can never
 * accidentally clamp the default.
 */
export function initialBackfillStart(cfg, now = new Date()) {
  const setting = cfg.sync?.initialBackfillFrom ?? 'last_24_months';
  const opts = {
    now,
    timeZone: cfg.timezone,
    fiscalYearStartMonth: cfg.fiscalYearStartMonth,
    fiscalYearNaming: cfg.fiscalYearNaming,
  };
  const resolved = setting === 'fy-start' ? resolveRange('this_fy', opts).start : resolveRange(setting, opts).start;

  const cap = resolveRange('last_24_months', opts).start;
  // The later (more recent) of the two: never let the resolved start reach further
  // back than the cap, but never pull it forward if it was already within it.
  return resolved > cap ? resolved : cap;
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
