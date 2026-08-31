import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpClient } from '../lib/http.mjs';
import {
  fetchGitHubEvents, normalizePullRequest, normalizeComment, normalizeReview, normalizeCommit, whoami,
} from '../lib/sources/github.mjs';
import { defaultConfig } from '../lib/config.mjs';
import * as fx from './fixtures/github.mjs';

const SYNCED = '2026-08-31T22:00:00.000Z';
const SINCE = '2026-08-01T00:00:00.000Z';
const NOW = new Date(SYNCED);

function config(over = {}) {
  const cfg = defaultConfig();
  cfg.identity = { githubLogin: 'janedoe' };
  cfg.sources.github = { ...cfg.sources.github, enabled: true, ...over };
  return cfg;
}

/** Routes requests by URL substring, so tests declare only what they care about. */
function routedHttp(routes, { record } = {}) {
  const fetcher = async (url) => {
    record?.push(url);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) throw new Error(`no fixture route for ${url}`);
    const value = routes[key];
    return {
      status: 200,
      ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify(typeof value === 'function' ? value(url) : value),
    };
  };
  return createHttpClient({ fetcher });
}

test('a merged PR yields both an opened and a merged event', () => {
  const events = normalizePullRequest(fx.authoredPr, { syncedAt: SYNCED });
  assert.equal(events.length, 2);

  const [opened, merged] = events;
  assert.equal(opened.event_type, 'pr_opened');
  assert.equal(opened.occurred_at, '2026-08-20T09:15:00Z');
  assert.equal(opened.external_id, 'octo/payments#42');
  assert.equal(opened.project, 'octo');
  assert.equal(opened.repo, 'payments');

  assert.equal(merged.event_type, 'pr_merged');
  assert.equal(merged.occurred_at, '2026-08-22T10:45:00Z', 'merge uses merged_at, not created_at');
  assert.equal(merged.status, 'merged');
});

test('an unmerged PR yields only an opened event', () => {
  const events = normalizePullRequest(fx.openPr, { syncedAt: SYNCED });
  assert.equal(events.length, 1);
  assert.equal(events[0].status, 'open');
});

test('a PR description with a date reference is flagged for enrichment', () => {
  const [opened, merged] = normalizePullRequest(fx.authoredPr, { syncedAt: SYNCED });
  assert.equal(opened.needs_enrichment, 1, '"Yesterday I finished..." should be examined');
  assert.equal(merged.needs_enrichment, 0, 'a merge timestamp is already precise');
});

test('a PR description without a date reference is not flagged', () => {
  assert.equal(normalizePullRequest(fx.openPr, { syncedAt: SYNCED })[0].needs_enrichment, 0);
});

test('bodies are truncated to maxBodyChars', () => {
  const long = { ...fx.openPr, body: 'x'.repeat(500) };
  const [e] = normalizePullRequest(long, { maxBodyChars: 100, syncedAt: SYNCED });
  assert.equal(e.body.length, 101, '100 characters plus the ellipsis');
  assert.ok(e.body.endsWith('…'));
});

test('a comment on an issue maps to ticket_comment, on a PR to pr_comment', () => {
  const onIssue = normalizeComment(fx.ownComment, fx.issueThread, { syncedAt: SYNCED });
  assert.equal(onIssue.event_type, 'ticket_comment');
  assert.equal(onIssue.needs_enrichment, 1, '"Last Friday" should be examined');
  assert.equal(onIssue.parent_key, 'octo/payments#91');

  const onPr = normalizeComment(fx.ownComment, fx.authoredPr, { syncedAt: SYNCED });
  assert.equal(onPr.event_type, 'pr_comment');
});

test('a review maps with its submitted time and state', () => {
  const e = normalizeReview(fx.ownReview, fx.reviewedPr, { syncedAt: SYNCED });
  assert.equal(e.event_type, 'pr_reviewed');
  assert.equal(e.status, 'APPROVED');
  assert.equal(e.occurred_at, '2026-08-27T12:00:00Z');
  assert.equal(e.external_id, 'review:777001');
});

test('a commit uses its author date and first message line', () => {
  const e = normalizeCommit(fx.commitItem, { syncedAt: SYNCED });
  assert.equal(e.event_type, 'commit');
  assert.equal(e.title, 'Fix rounding in settlement totals');
  assert.equal(e.occurred_at, '2026-08-27T08:12:00Z');
  assert.equal(e.needs_enrichment, 0, 'commit dates are authoritative');
});

test('a full fetch collects PRs, comments and reviews', async () => {
  const http = routedHttp({
    'q=author': { items: [fx.authoredPr, fx.openPr] },
    'q=commenter': { items: [fx.issueThread] },
    'q=reviewed-by': { items: [fx.reviewedPr] },
    '/issues/91/comments': [fx.ownComment, fx.otherPersonsComment, fx.staleComment],
    '/pulls/77/reviews': [fx.ownReview],
  });

  const { events, cursor } = await fetchGitHubEvents({ cfg: config(), token: 't', http, since: SINCE, now: NOW });
  const byType = events.reduce((acc, e) => ({ ...acc, [e.event_type]: (acc[e.event_type] ?? 0) + 1 }), {});

  assert.deepEqual(byType, { pr_opened: 2, pr_merged: 1, ticket_comment: 1, pr_reviewed: 1 });
  assert.equal(cursor, SYNCED, 'cursor advances to the run time');
});

test("another person's comments are never recorded as the user's work", async () => {
  const http = routedHttp({
    'q=author': { items: [] },
    'q=commenter': { items: [fx.issueThread] },
    'q=reviewed-by': { items: [] },
    '/issues/91/comments': [fx.ownComment, fx.otherPersonsComment],
  });

  const { events } = await fetchGitHubEvents({ cfg: config(), token: 't', http, since: SINCE, now: NOW });
  assert.equal(events.length, 1);
  assert.equal(events[0].external_id, 'comment:555001');
  assert.ok(!JSON.stringify(events).includes('someone-else'), 'no foreign authorship should leak in');
});

test('events older than the sync window are dropped', async () => {
  const http = routedHttp({
    'q=author': { items: [] },
    'q=commenter': { items: [fx.issueThread] },
    'q=reviewed-by': { items: [] },
    '/issues/91/comments': [fx.staleComment],
  });
  const { events } = await fetchGitHubEvents({ cfg: config(), token: 't', http, since: SINCE, now: NOW });
  assert.equal(events.length, 0, 'the search index can return stale rows; the mapper re-filters');
});

test('commits are skipped unless explicitly enabled', async () => {
  const record = [];
  // Listed first: the commit search URL also contains `q=author`.
  const routes = {
    'search/commits': { items: [fx.commitItem] },
    'q=author': { items: [] },
    'q=commenter': { items: [] },
    'q=reviewed-by': { items: [] },
  };

  await fetchGitHubEvents({ cfg: config(), token: 't', http: routedHttp(routes, { record }), since: SINCE, now: NOW });
  assert.ok(!record.some((u) => u.includes('search/commits')), 'the expensive call must not fire by default');

  const { events } = await fetchGitHubEvents({
    cfg: config({ includeCommits: true }), token: 't', http: routedHttp(routes), since: SINCE, now: NOW,
  });
  assert.equal(events.filter((e) => e.event_type === 'commit').length, 1);
});

test('configured orgs scope every search query', async () => {
  const record = [];
  const http = routedHttp({ 'q=': { items: [] } }, { record });
  await fetchGitHubEvents({ cfg: config({ orgs: ['octo'] }), token: 't', http, since: SINCE, now: NOW });

  assert.ok(record.length >= 3);
  for (const url of record) assert.ok(decodeURIComponent(url).includes('org:octo'), url);
});

test('a missing identity fails loudly rather than syncing the wrong person', async () => {
  const cfg = config();
  delete cfg.identity.githubLogin;
  await assert.rejects(
    () => fetchGitHubEvents({ cfg, token: 't', http: routedHttp({}), since: SINCE, now: NOW }),
    /identity.githubLogin is not set/,
  );
});

test('a missing token fails before any request is made', async () => {
  const record = [];
  await assert.rejects(
    () => fetchGitHubEvents({ cfg: config(), token: null, http: routedHttp({}, { record }), since: SINCE, now: NOW }),
    /no GitHub token/,
  );
  assert.equal(record.length, 0);
});

test('whoami resolves the login so setup never stores a guess', async () => {
  const http = routedHttp({ '/user': { login: 'janedoe', name: 'Jane Doe' } });
  assert.deepEqual(await whoami({ token: 't', http }), { login: 'janedoe', name: 'Jane Doe' });
});
