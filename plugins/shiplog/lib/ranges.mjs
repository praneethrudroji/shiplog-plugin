// Ranges are half-open: [start, end). Boundaries are local-midnight in the configured
// timezone, expressed as UTC instants.

const MS_PER_DAY = 86_400_000;

const NAMED = new Set([
  'today', 'yesterday', 'last_working_day', 'since_last_working_day',
  'this_week', 'last_week',
  'this_month', 'last_month',
  'this_quarter', 'last_quarter',
  'this_fy', 'last_fy',
  'all_time',
]);

function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function civilToDays(c) {
  return Math.floor(Date.UTC(c.y, c.m - 1, c.d) / MS_PER_DAY);
}

function daysToCivil(n) {
  const dt = new Date(n * MS_PER_DAY);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function addDays(c, n) {
  return daysToCivil(civilToDays(c) + n);
}

function addMonths(c, n) {
  const total = c.y * 12 + (c.m - 1) + n;
  const y = Math.floor(total / 12);
  const m = (total % 12 + 12) % 12 + 1;
  return { y, m, d: Math.min(c.d, daysInMonth(y, m)) };
}

// 0 = Sunday
function weekdayOf(c) {
  return new Date(Date.UTC(c.y, c.m - 1, c.d)).getUTCDay();
}

function fmtCivil(c) {
  return `${String(c.y).padStart(4, '0')}-${String(c.m).padStart(2, '0')}-${String(c.d).padStart(2, '0')}`;
}

const PART_FORMATTERS = new Map();
function partsFormatter(timeZone) {
  let f = PART_FORMATTERS.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    PART_FORMATTERS.set(timeZone, f);
  }
  return f;
}

/** Calendar date and clock time of a UTC instant, as seen in `timeZone`. */
export function zonedParts(instant, timeZone) {
  const parts = {};
  for (const p of partsFormatter(timeZone).formatToParts(instant)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  // hour12:false can emit hour 24 for midnight in some ICU versions.
  return { y: parts.year, m: parts.month, d: parts.day, hour: parts.hour % 24, minute: parts.minute, second: parts.second };
}

function offsetMsAt(instant, timeZone) {
  const p = zonedParts(instant, timeZone);
  return Date.UTC(p.y, p.m - 1, p.d, p.hour, p.minute, p.second) - instant.getTime();
}

/**
 * The UTC instant of local midnight starting the given calendar day in `timeZone`.
 * Two passes: the first offset guess can be wrong across a DST transition, so it is
 * re-derived from the corrected instant.
 */
export function zonedMidnightUTC(c, timeZone) {
  const guess = Date.UTC(c.y, c.m - 1, c.d);
  let ts = guess - offsetMsAt(new Date(guess), timeZone);
  ts = guess - offsetMsAt(new Date(ts), timeZone);
  return new Date(ts);
}

/** The calendar year in which the fiscal year containing (y, m) began. */
export function fiscalYearStartYear(y, m, startMonth) {
  return m >= startMonth ? y : y - 1;
}

/**
 * A January fiscal start is just the calendar year, so `end_year` naming would label
 * 2026 as "FY2027". Force `start_year` there rather than honor a nonsensical config.
 */
export function fiscalYearLabel(startYear, startMonth, naming) {
  if (startMonth === 1) return startYear;
  return naming === 'end_year' ? startYear + 1 : startYear;
}

export function fiscalYearFromLabel(label, startMonth, naming) {
  if (startMonth === 1) return label;
  return naming === 'end_year' ? label - 1 : label;
}

/** Fiscal quarter (1-4) of a calendar month, relative to the fiscal start month. */
export function fiscalQuarter(y, m, startMonth) {
  const startYear = fiscalYearStartYear(y, m, startMonth);
  const monthsIn = (y - startYear) * 12 + (m - startMonth);
  return Math.floor(monthsIn / 3) + 1;
}

function fyBounds(startYear, startMonth) {
  const start = { y: startYear, m: startMonth, d: 1 };
  return { start, end: addMonths(start, 12) };
}

function quarterBounds(y, m, startMonth) {
  const startYear = fiscalYearStartYear(y, m, startMonth);
  const q = fiscalQuarter(y, m, startMonth);
  const start = addMonths({ y: startYear, m: startMonth, d: 1 }, (q - 1) * 3);
  return { start, end: addMonths(start, 3), quarter: q, fyStartYear: startYear };
}

function weekStart(c, weekStartsOn) {
  const shift = (weekdayOf(c) - weekStartsOn + 7) % 7;
  return addDays(c, -shift);
}

function isWeekend(c, weekendDays) {
  return weekendDays.includes(weekdayOf(c));
}

/** Walks backward from `c` to the most recent day not in `weekendDays`. */
function lastWorkingDayBefore(c, weekendDays) {
  let d = addDays(c, -1);
  while (isWeekend(d, weekendDays)) d = addDays(d, -1);
  return d;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseISODate(s) {
  const m = ISO_DATE.exec(s);
  if (!m) return null;
  const c = { y: +m[1], m: +m[2], d: +m[3] };
  if (c.m < 1 || c.m > 12 || c.d < 1 || c.d > daysInMonth(c.y, c.m)) return null;
  return c;
}

export const SUPPORTED_RANGES = [
  ...NAMED,
  'last_N_days | last_N_weeks | last_N_months',
  'fyYYYY (e.g. fy2026)',
  'YYYY-MM-DD',
  'YYYY-MM-DD..YYYY-MM-DD',
];

/**
 * Resolve a range expression into concrete UTC bounds.
 * Returns { start, end, startDate, endDate, label } where `end` is exclusive and
 * `endDate` is the inclusive final calendar day (what a human expects to read).
 */
export function resolveRange(expression, opts = {}) {
  const {
    now = new Date(),
    timeZone = 'UTC',
    fiscalYearStartMonth = 1,
    fiscalYearNaming = 'start_year',
    weekStartsOn = 1,
    weekendDays = [0, 6],
    coverageStart = null,
  } = opts;

  if (typeof expression !== 'string' || !expression.trim()) {
    throw new Error('range expression is required');
  }

  const raw = expression.trim();
  const today = zonedParts(now, timeZone);
  const todayCivil = { y: today.y, m: today.m, d: today.d };

  let bounds = null;
  let label = null;
  // Declared out here rather than inside the named-range branch so the return can
  // report it. Stays null for explicit dates and ISO ranges, which have no key.
  let key = null;

  // Explicit forms are matched before normalization, which would eat the hyphens.
  const explicitRange = raw.split('..');
  if (explicitRange.length === 2) {
    const a = parseISODate(explicitRange[0].trim());
    const b = parseISODate(explicitRange[1].trim());
    if (!a || !b) throw new Error(`invalid explicit range: ${raw}`);
    if (civilToDays(b) < civilToDays(a)) throw new Error(`range ends before it starts: ${raw}`);
    bounds = { start: a, end: addDays(b, 1) };   // inclusive end date -> exclusive bound
    label = `${fmtCivil(a)} to ${fmtCivil(b)}`;
  } else {
    const single = parseISODate(raw);
    if (single) {
      bounds = { start: single, end: addDays(single, 1) };
      label = fmtCivil(single);
    }
  }

  if (!bounds) {
    key = raw.toLowerCase().replace(/[\s-]+/g, '_').replace(/_+/g, '_');

    const lastN = /^last_(\d+)_(day|week|month)s?$/.exec(key);
    const fyLabel = /^fy_?(\d{4})$/.exec(key);

    if (lastN) {
      const n = Number(lastN[1]);
      if (n < 1) throw new Error(`range count must be at least 1: ${raw}`);
      const unit = lastN[2];
      // Inclusive of today: "last 7 days" ends tonight and covers 7 calendar days.
      const end = addDays(todayCivil, 1);
      const start = unit === 'day' ? addDays(end, -n)
        : unit === 'week' ? addDays(end, -n * 7)
        : addMonths(end, -n);
      bounds = { start, end };
      label = `last ${n} ${unit}${n === 1 ? '' : 's'}`;
    } else if (fyLabel) {
      const startYear = fiscalYearFromLabel(Number(fyLabel[1]), fiscalYearStartMonth, fiscalYearNaming);
      bounds = fyBounds(startYear, fiscalYearStartMonth);
      label = `FY${fyLabel[1]}`;
    } else if (NAMED.has(key)) {
      switch (key) {
        case 'today':
          bounds = { start: todayCivil, end: addDays(todayCivil, 1) };
          label = 'today';
          break;
        case 'yesterday': {
          const y = addDays(todayCivil, -1);
          bounds = { start: y, end: todayCivil };
          label = 'yesterday';
          break;
        }
        case 'last_working_day': {
          const d = lastWorkingDayBefore(todayCivil, weekendDays);
          bounds = { start: d, end: addDays(d, 1) };
          label = 'last working day';
          break;
        }
        // The standup range. Unlike last_working_day, which is that one day and
        // stops, this runs from the last working day through the end of today, so
        // today's own work is included. A standup is "what I did last, and what
        // I'm on now", and the single-day range can only ever answer the first
        // half of that.
        case 'since_last_working_day': {
          const d = lastWorkingDayBefore(todayCivil, weekendDays);
          bounds = { start: d, end: addDays(todayCivil, 1) };
          label = 'since last working day';
          break;
        }
        case 'this_week': {
          const s = weekStart(todayCivil, weekStartsOn);
          bounds = { start: s, end: addDays(s, 7) };
          label = 'this week';
          break;
        }
        case 'last_week': {
          const s = addDays(weekStart(todayCivil, weekStartsOn), -7);
          bounds = { start: s, end: addDays(s, 7) };
          label = 'last week';
          break;
        }
        case 'this_month': {
          const s = { y: today.y, m: today.m, d: 1 };
          bounds = { start: s, end: addMonths(s, 1) };
          label = 'this month';
          break;
        }
        case 'last_month': {
          const s = addMonths({ y: today.y, m: today.m, d: 1 }, -1);
          bounds = { start: s, end: addMonths(s, 1) };
          label = 'last month';
          break;
        }
        case 'this_quarter': {
          const q = quarterBounds(today.y, today.m, fiscalYearStartMonth);
          bounds = { start: q.start, end: q.end };
          label = `Q${q.quarter} FY${fiscalYearLabel(q.fyStartYear, fiscalYearStartMonth, fiscalYearNaming)}`;
          break;
        }
        case 'last_quarter': {
          const cur = quarterBounds(today.y, today.m, fiscalYearStartMonth);
          const s = addMonths(cur.start, -3);
          const q = quarterBounds(s.y, s.m, fiscalYearStartMonth);
          bounds = { start: s, end: addMonths(s, 3) };
          label = `Q${q.quarter} FY${fiscalYearLabel(q.fyStartYear, fiscalYearStartMonth, fiscalYearNaming)}`;
          break;
        }
        case 'this_fy':
        case 'last_fy': {
          let startYear = fiscalYearStartYear(today.y, today.m, fiscalYearStartMonth);
          if (key === 'last_fy') startYear -= 1;
          bounds = fyBounds(startYear, fiscalYearStartMonth);
          label = `FY${fiscalYearLabel(startYear, fiscalYearStartMonth, fiscalYearNaming)}`;
          break;
        }
        case 'all_time': {
          const s = coverageStart ? parseISODate(coverageStart) : { y: 1970, m: 1, d: 1 };
          bounds = { start: s ?? { y: 1970, m: 1, d: 1 }, end: addDays(todayCivil, 1) };
          label = 'all time';
          break;
        }
      }
    }
  }

  if (!bounds) {
    throw new Error(
      `unrecognized range: "${raw}". Supported: ${SUPPORTED_RANGES.join(', ')}`,
    );
  }

  const endInclusive = addDays(bounds.end, -1);
  return {
    // The normalized expression this resolved from, so a caller can branch on which
    // range it got without parsing the human-readable label back apart.
    key,
    start: zonedMidnightUTC(bounds.start, timeZone).toISOString(),
    end: zonedMidnightUTC(bounds.end, timeZone).toISOString(),
    startDate: fmtCivil(bounds.start),
    endDate: fmtCivil(endInclusive),
    label: `${label} (${fmtCivil(bounds.start)} to ${fmtCivil(endInclusive)})`,
  };
}
