import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveRange } from './ranges.mjs';
import { rangeOptions } from './config.mjs';
import { getStats, queryEvents, getSyncHealth } from './db.mjs';

const MAX_TITLE = 120;

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

/** Plain text, deterministic, no LLM - see docs/DECISIONS.md D20. */
export function formatStandupSummary(db, cfg, range) {
  const stats = getStats(db, { start: range.start, end: range.end, group_by: 'event_type' });
  const health = getSyncHealth(db);

  if (stats.total === 0) {
    return `📋 worklog: no tracked activity for ${range.label}.`;
  }

  const lines = [`📋 worklog - ${range.label}:`];
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

  const events = queryEvents(db, { start: range.start, end: range.end, limit: 5 });
  if (events.length) {
    lines.push('', 'Highlights:');
    for (const e of events) {
      lines.push(`  - ${sanitizeForDisplay(e.title) || e.event_type}${e.url ? ` (${sanitizeForDisplay(e.url)})` : ''}`);
    }
  }

  const stale = Object.entries(health.sources)
    .filter(([, s]) => s && s.last_status === 'error')
    .map(([source]) => source);
  if (stale.length) lines.push('', `⚠ last sync failed for: ${stale.join(', ')} - run /worklog-status`);

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
  const summary = db ? formatStandupSummary(db, cfg, range) : null;
  saveStandupState(statePath, { lastShownDate: today });
  return summary;
}
