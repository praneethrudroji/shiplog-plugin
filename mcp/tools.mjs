import { resolveRange, SUPPORTED_RANGES } from '../lib/ranges.mjs';
import { rangeOptions, enabledSources } from '../lib/config.mjs';
import { getStats, queryEvents, listProjects, getSyncHealth, coverageStart } from '../lib/db.mjs';

export const TOOLS = [
  {
    name: 'resolve_range',
    description:
      'Resolve a natural-language or named time range (e.g. "last 3 weeks", "this_quarter", '
      + '"this_fy", "fy2026", an ISO date, or an ISO date range) into concrete UTC boundaries, '
      + "using the user's configured fiscal year and timezone. Call this before query_events or "
      + 'get_stats - never compute date arithmetic yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: `A range expression. Supported forms: ${SUPPORTED_RANGES.join(', ')}.`,
        },
      },
      required: ['expression'],
    },
  },
  {
    name: 'get_stats',
    description:
      'Aggregate counts of events (PRs opened/merged, reviews, tickets, comments, deployments) '
      + 'over a date range, grouped by event_type, source, project, or day. Use this for '
      + '"how many" questions before pulling individual rows with query_events.',
    inputSchema: {
      type: 'object',
      properties: {
        start: { type: 'string', description: 'Range start, from resolve_range (ISO date or instant).' },
        end: { type: 'string', description: 'Range end, exclusive, from resolve_range.' },
        group_by: { type: 'string', enum: ['event_type', 'source', 'project', 'day'], default: 'event_type' },
      },
      required: ['start', 'end'],
    },
  },
  {
    name: 'query_events',
    description:
      'List individual events in a date range, with links, so you can cite specific work. '
      + 'Supports filtering by source, event type, project, and a text search over title/body. '
      + 'Prefer get_stats for counts; use this when the user wants specifics or a summary '
      + "with citations. Every result includes both when the work was attributed to (effective) "
      + 'and when the source recorded it (occurred), so an answer can state its own basis.',
    inputSchema: {
      type: 'object',
      properties: {
        start: { type: 'string' },
        end: { type: 'string' },
        sources: { type: 'array', items: { type: 'string', enum: ['github', 'azure_devops', 'jira'] } },
        event_types: { type: 'array', items: { type: 'string' } },
        project: { type: 'string' },
        text_search: { type: 'string' },
        limit: { type: 'integer', default: 500, maximum: 2000 },
      },
      required: ['start', 'end'],
    },
  },
  {
    name: 'list_projects',
    description: 'List the projects/repos with activity in a range (or all time, if no range is given), with counts. Useful for scoping a broad question before drilling in.',
    inputSchema: {
      type: 'object',
      properties: { start: { type: 'string' }, end: { type: 'string' } },
    },
  },
  {
    name: 'get_sync_health',
    description:
      "Report each source's last successful sync time and status, the size of the pending "
      + 'date-attribution backlog, and the earliest date the database has data for. '
      + 'Call this before answering any question and mention staleness if the last sync for a '
      + "relevant source is old - don't present a gap in data collection as a quiet period of work.",
    inputSchema: { type: 'object', properties: {} },
  },
];

function textResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function errorResult(message) {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

/**
 * Builds the name -> handler map. `db` may be null (no sync has run yet); handlers that
 * need it fail with a clear, catchable message rather than throwing a raw SQLite error.
 */
export function createToolHandlers({ cfg, getDb }) {
  const requireDb = () => {
    const db = getDb();
    if (!db) throw new Error('no data yet - run /shiplog-sync (or wait for the first scheduled run)');
    return db;
  };

  return {
    resolve_range({ expression }) {
      if (!cfg) throw new Error('shiplog is not configured yet - run /shiplog-setup');
      const opts = rangeOptions(cfg);
      if (expression === 'all_time') opts.coverageStart = coverageStart(requireDb());
      return resolveRange(expression, opts);
    },

    get_stats({ start, end, group_by = 'event_type' }) {
      return getStats(requireDb(), { start, end, groupBy: group_by, timezone: cfg?.timezone });
    },

    query_events({ start, end, sources, event_types, project, text_search, limit }) {
      return queryEvents(requireDb(), {
        start, end, sources, eventTypes: event_types, project, textSearch: text_search, limit,
        timezone: cfg?.timezone,
      });
    },

    list_projects({ start, end } = {}) {
      return listProjects(requireDb(), start && end ? { start, end, timezone: cfg?.timezone } : {});
    },

    get_sync_health() {
      const db = getDb();
      const health = db ? getSyncHealth(db) : { sources: {}, pendingEnrichment: 0, coverageStart: null };
      const enabled = cfg ? enabledSources(cfg) : [];
      const neverSynced = enabled.filter((s) => !health.sources[s]);
      return { ...health, enabledSources: enabled, neverSynced };
    },
  };
}

/** Dispatches one MCP tools/call by name, converting thrown errors into a tool-error result. */
export function callTool(handlers, name, args) {
  const handler = handlers[name];
  if (!handler) return errorResult(`unknown tool: ${name}`);
  try {
    return textResult(handler(args ?? {}));
  } catch (err) {
    return errorResult(err.message);
  }
}
