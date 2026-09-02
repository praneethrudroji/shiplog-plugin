import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveRange } from './ranges.mjs';
import { rangeOptions } from './config.mjs';
import { getStats, queryEvents, getSyncHealth } from './db.mjs';

const MAX_TITLE = 120;

// A standup spanning a weekend or a long gap can cover a lot of events, and this
// text is injected into Claude's context at session start, so it needs a ceiling.
// Per-day rather than overall, so a busy Friday cannot crowd today out of its own
// standup entirely.
const MAX_SECTION_EVENTS = 40;
const MAX_EVENTS_PER_DAY = 5;

/**
 * Titles and URLs here originate in systems other people can write to (a PR title, a
 * ticket subject), and this text is injected into Claude's context by the SessionStart
 * hook. Flattening newlines and control characters keeps a crafted title from
 * presenting itself as separate instructions once it lands in that context, and the
 * length cap bounds how much a single row can contribute.
 */
export function sanitizeForDisplay(value, max = MAX_TITLE) {
  if (value === null || value === undefined) return '';
  const flat = String(value)
    // Control characters, plus the Unicode line and paragraph separators.
    .replace(/[\u0000-\u001F\u007F\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? flat.slice(0, max) + '...' : flat;
}

/** Today's calendar date in the configured timezone - the unit "once a day" is measured in. */
function todayIn(cfg, now) {
  return resolveRange('today', rangeOptions(cfg, now)).startDate;
}

export function loadStandupState(path) {
  if (!existsSync(path)) return { lastShownDate: null };
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { lastShownDate: null };   // a corrupt state file must not block the feature forever
  }
}

export function saveStandupState(path, state) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
}

export function alreadyShownToday(state, todayDate) {
  return state.lastShownDate === todayDate;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * How one day's section is headed. "Yesterday" is used only when the day genuinely
 * is yesterday: on a Monday the previous working day is Friday, and calling that
 * "Yesterday" would be plainly wrong to anyone reading their own standup.
 *
 * Dates are parsed as UTC and read back with the UTC getters deliberately. These are
 * already local calendar dates (YYYY-MM-DD), produced by the range engine in the
 * configured timezone, so they must not be shifted a second time.
 */
export function dayHeading(dateStr, todayStr) {
  if (dateStr === todayStr) return 'Today';

  const date = new Date(`${dateStr}T00:00:00Z`);
  const today = new Date(`${todayStr}T00:00:00Z`);
  const daysBefore = Math.round((today - date) / 86_400_000);
  if (daysBefore === 1) return 'Yesterday';

  return `${WEEKDAYS[date.getUTCDay()]}, ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

/**
 * Groups events by the date the work is attributed to, oldest first, so the summary
 * reads the way a standup is actually spoken: what happened last, then today.
 *
 * Only days with activity get a section, so an ordinary Monday shows Friday and
 * Today rather than three empty weekend headings. Days that do have activity are
 * always shown, including weekends: quietly dropping Saturday's work would
 * contradict the point of a tool whose whole purpose is an accurate record.
 */
export function groupByDay(events) {
  const byDay = new Map();
  for (const event of events) {
    const day = event.effective_date;
    if (!day) continue;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(event);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, dayEvents]) => ({ date, events: dayEvents }));
}

/**
 * Plain text, deterministic, no LLM - see docs/DECISIONS.md D20.
 *
 * `now` is injected rather than read from the clock inside, because the day headings
 * ("Today", "Yesterday") are relative to it, and a test that cannot fix the current
 * date cannot check them.
 */
export function formatStandupSummary(db, cfg, range, now = new Date()) {
  const stats = getStats(db, { start: range.start, end: range.end, group_by: 'event_type' });
  const health = getSyncHealth(db);

  if (stats.total === 0) {
    return `📋 shiplog: no tracked activity for ${range.label}.`;
  }

  const lines = [`📋 shiplog - ${range.label}:`];
  // {one, many} rather than a single string + a naive trailing "s" - "PR opened"
  // pluralizes as "PRs opened", not "PR openeds".
  const label = {
    pr_opened: ['PR opened', 'PRs opened'],
    pr_merged: ['PR merged', 'PRs merged'],
    pr_reviewed: ['review', 'reviews'],
    pr_comment: ['PR comment', 'PR comments'],
    commit: ['commit', 'commits'],
    ticket_created: ['ticket created', 'tickets created'],
    ticket_comment: ['ticket comment', 'ticket comments'],
    ticket_status_change: ['ticket status change', 'ticket status changes'],
    deployment_request: ['deployment', 'deployments'],
  };
  for (const row of stats.byKey) {
    const [one, many] = label[row.key] ?? [row.key, row.key];
    lines.push(`  • ${row.count} ${row.count === 1 ? one : many}`);
  }

  const describe = (e) => `  - ${sanitizeForDisplay(e.title) || e.event_type}${e.url ? ` (${sanitizeForDisplay(e.url)})` : ''}`;

  // Per-day sections only for the standup's own range. last_week and last_month keep
  // the flat list, because thirty day-headings is a log, not a summary.
  if (range.key === 'since_last_working_day') {
    const events = queryEvents(db, {
      start: range.start, end: range.end, limit: MAX_SECTION_EVENTS, timezone: cfg.timezone,
    });
    const today = todayIn(cfg, now);
    for (const day of groupByDay(events)) {
      lines.push('', `${dayHeading(day.date, today)}:`);
      for (const e of day.events.slice(0, MAX_EVENTS_PER_DAY)) lines.push(describe(e));

      const hidden = day.events.length - MAX_EVENTS_PER_DAY;
      if (hidden > 0) lines.push(`  - and ${hidden} more`);
    }
  } else {
    const events = queryEvents(db, { start: range.start, end: range.end, limit: 5, timezone: cfg.timezone });
    if (events.length) {
      lines.push('', 'Highlights:');
      for (const e of events) lines.push(describe(e));
    }
  }

  const stale = Object.entries(health.sources)
    .filter(([, s]) => s && s.last_status === 'error')
    .map(([source]) => source);
  if (stale.length) lines.push('', `⚠ last sync failed for: ${stale.join(', ')} - run /shiplog-status`);

  return lines.join('\n');
}

/**
 * The orchestration a hook script calls. Returns null when nothing should be shown
 * (disabled, already shown today, or no config/data yet) so the hook prints nothing
 * rather than erroring a session start over a missing setup step.
 */
export function runStandupCheck({ cfg, db, statePath, now = new Date() }) {
  if (!cfg?.standup?.enabled) return null;

  const today = todayIn(cfg, now);
  const state = loadStandupState(statePath);
  if (alreadyShownToday(state, today)) return null;

  const range = resolveRange(cfg.standup.range, rangeOptions(cfg, now));
  const summary = db ? formatStandupSummary(db, cfg, range, now) : null;
  saveStandupState(statePath, { lastShownDate: today });
  return summary;
}
