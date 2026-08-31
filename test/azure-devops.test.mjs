import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpClient } from '../lib/http.mjs';
import {
  fetchAzureDevOpsEvents, normalizePullRequest, normalizeReviewVote, normalizePrComment,
  normalizeWorkItemCreated, normalizeWorkItemComment, normalizeStatusChange, normalizeDeployment, whoami,
} from '../lib/sources/azure-devops.mjs';
import { defaultConfig } from '../lib/config.mjs';
import * as fx from './fixtures/azure-devops.mjs';

const SYNCED = '2026-08-31T22:00:00.000Z';
const SINCE = '2026-08-01T00:00:00.000Z';
const NOW = new Date(SYNCED);
const ORG = 'fabrikam';

function config(over = {}) {
  const cfg = defaultConfig();
  cfg.identity = { adoUserId: fx.ME.id };
  cfg.sources.azure_devops = { enabled: true, orgUrl: ORG, projects: ['Payments'], tokenEnv: 'T', ...over };
  return cfg;
}

function routedHttp(routes, { record } = {}) {
  const fetcher = async (url, opts) => {
    record?.push(url);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) throw new Error(`no fixture route for ${url}${opts?.method ? ` (${opts.method})` : ''}`);
    const value = routes[key];
    const resolved = typeof value === 'function' ? value(url, opts) : value;
    return { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify(resolved) };
  };
  return createHttpClient({ fetcher });
}

// --- normalize* unit tests ---------------------------------------------------

test('a completed PR yields both an opened and a merged event', () => {
  const events = normalizePullRequest(fx.mergedPr, { org: ORG, syncedAt: SYNCED });
  assert.equal(events.length, 2);
  const [opened, merged] = events;
  assert.equal(opened.event_type, 'pr_opened');
  assert.equal(opened.occurred_at, '2026-08-20T09:15:00Z');
  assert.equal(opened.external_id, 'Payments/payments#22');
  assert.match(opened.url, /_git\/payments\/pullrequest\/22$/);
  assert.equal(merged.event_type, 'pr_merged');
  assert.equal(merged.occurred_at, '2026-08-22T10:45:00Z');
});

test('an active PR yields only an opened event', () => {
  const events = normalizePullRequest(fx.activePr, { org: ORG, syncedAt: SYNCED });
  assert.equal(events.length, 1);
  assert.equal(events[0].status, 'active');
});

test('a PR description with a date reference is flagged; the merge is not', () => {
  const [opened, merged] = normalizePullRequest(fx.mergedPr, { org: ORG, syncedAt: SYNCED });
  assert.equal(opened.needs_enrichment, 1);
  assert.equal(merged.needs_enrichment, 0);
});

test('a review vote is parsed from the system comment text, with a real timestamp', () => {
  const e = normalizeReviewVote(fx.threadsForReviewedPr[0].comments[0], fx.reviewedPr, { org: ORG, syncedAt: SYNCED });
  assert.equal(e.event_type, 'pr_reviewed');
  assert.equal(e.status, 'approved');
  assert.equal(e.occurred_at, '2026-08-27T12:00:00Z');
});

test('a text comment on a PR maps to pr_comment', () => {
  const e = normalizePrComment(fx.threadsForMergedPr[0].comments[0], fx.mergedPr, { org: ORG, syncedAt: SYNCED });
  assert.equal(e.event_type, 'pr_comment');
  assert.equal(e.parent_key, 'Payments/payments#22');
});

test('a work item created by me maps to ticket_created', () => {
  const item = fx.workItemBatch.value[0];
  const e = normalizeWorkItemCreated(item, { org: ORG, syncedAt: SYNCED });
  assert.equal(e.event_type, 'ticket_created');
  assert.equal(e.occurred_at, '2026-08-15T08:00:00Z');
  assert.match(e.url, /_workitems\/edit\/299$/);
});

test('a work item comment is flagged for enrichment when it references a date', () => {
  const item = fx.workItemBatch.value[0];
  const e = normalizeWorkItemComment(fx.workItemComments.comments[0], item, { org: ORG, syncedAt: SYNCED });
  assert.equal(e.needs_enrichment, 1, '"Last Friday" should be examined');
});

test('a status change with an oldValue is a real transition', () => {
  const item = fx.workItemBatch.value[0];
  const e = normalizeStatusChange(fx.workItemUpdates.value[1], item, { org: ORG, syncedAt: SYNCED });
  assert.equal(e.event_type, 'ticket_status_change');
  assert.equal(e.status, 'Resolved');
  assert.equal(e.body, 'Active → Resolved');
});

test('the creation revision (no oldValue) is not a status change', () => {
  const item = fx.workItemBatch.value[0];
  assert.equal(normalizeStatusChange(fx.workItemUpdates.value[0], item, { org: ORG, syncedAt: SYNCED }), null);
});

test('a deployment uses the best available completion timestamp', () => {
  const e = normalizeDeployment(fx.deployments.value[0], { org: ORG, project: 'Payments', syncedAt: SYNCED });
  assert.equal(e.event_type, 'deployment_request');
  assert.equal(e.occurred_at, '2026-08-29T16:55:00.133Z', 'falls back to lastModifiedOn when completedOn is absent');
  assert.equal(e.project, 'Payments');
});

// --- fetchAzureDevOpsEvents: full orchestration ------------------------------

function fullRoutes() {
  return {
    'searchCriteria.creatorId': { value: [fx.mergedPr, fx.activePr] },
    'searchCriteria.reviewerId': { value: [fx.reviewedPr] },
    [`repositories/${fx.mergedPr.repository.id}/pullRequests/22/threads`]: { value: fx.threadsForMergedPr },
    [`repositories/${fx.activePr.repository.id}/pullRequests/23/threads`]: { value: [] },
    [`repositories/${fx.reviewedPr.repository.id}/pullRequests/77/threads`]: { value: fx.threadsForReviewedPr },
    '_apis/wit/wiql': fx.wiqlResult,
    '_apis/wit/workitemsbatch': fx.workItemBatch,
    '/comments?api-version': fx.workItemComments,
    '/updates?api-version': fx.workItemUpdates,
    '_apis/release/deployments': fx.deployments,
  };
}

test('a full fetch collects PRs, comments, votes, work items, and deployments', async () => {
  const http = routedHttp(fullRoutes());
  const { events, cursor } = await fetchAzureDevOpsEvents({ cfg: config(), token: 't', http, since: SINCE, now: NOW });

  const byType = events.reduce((acc, e) => ({ ...acc, [e.event_type]: (acc[e.event_type] ?? 0) + 1 }), {});
  assert.deepEqual(byType, {
    pr_opened: 2, pr_merged: 1, pr_comment: 1, pr_reviewed: 1,
    ticket_created: 1, ticket_comment: 1, ticket_status_change: 1, deployment_request: 1,
  });
  assert.equal(cursor, SYNCED);
});

test('a PR reviewed but not authored produces no pr_opened event for me', async () => {
  const http = routedHttp(fullRoutes());
  const { events } = await fetchAzureDevOpsEvents({ cfg: config(), token: 't', http, since: SINCE, now: NOW });
  const opens = events.filter((e) => e.event_type === 'pr_opened');
  assert.ok(!opens.some((e) => e.external_id.includes('#77')), "reviewing isn't authoring");
});

test("another person's comments and votes are never recorded as mine", async () => {
  const http = routedHttp(fullRoutes());
  const { events } = await fetchAzureDevOpsEvents({ cfg: config(), token: 't', http, since: SINCE, now: NOW });
  assert.ok(!JSON.stringify(events).includes('Someone Else'));
});

test('the abandoned-later status transition by someone else is excluded', async () => {
  const http = routedHttp(fullRoutes());
  const { events } = await fetchAzureDevOpsEvents({ cfg: config(), token: 't', http, since: SINCE, now: NOW });
  const changes = events.filter((e) => e.event_type === 'ticket_status_change');
  assert.equal(changes.length, 1, "the OTHER-authored Resolved->Closed transition must be excluded");
  assert.equal(changes[0].status, 'Resolved');
});

test('deployments are skipped when includeDeployments is explicitly false', async () => {
  const record = [];
  const http = routedHttp(fullRoutes(), { record });
  const { events } = await fetchAzureDevOpsEvents({
    cfg: config({ includeDeployments: false }), token: 't', http, since: SINCE, now: NOW,
  });
  assert.ok(!record.some((u) => u.includes('release/deployments')));
  assert.equal(events.filter((e) => e.event_type === 'deployment_request').length, 0);
});

test('multiple configured projects are each queried independently', async () => {
  const record = [];
  const http = routedHttp(fullRoutes(), { record });
  await fetchAzureDevOpsEvents({ cfg: config({ projects: ['Payments', 'Ledger'] }), token: 't', http, since: SINCE, now: NOW });
  assert.ok(record.some((u) => u.includes('/Payments/')));
  assert.ok(record.some((u) => u.includes('/Ledger/')));
});

test('a missing identity fails loudly rather than syncing the wrong person', async () => {
  const cfg = config();
  delete cfg.identity.adoUserId;
  await assert.rejects(
    () => fetchAzureDevOpsEvents({ cfg, token: 't', http: routedHttp({}), since: SINCE, now: NOW }),
    /identity.adoUserId is not set/,
  );
});

test('a missing token fails before any request is made', async () => {
  const record = [];
  await assert.rejects(
    () => fetchAzureDevOpsEvents({ cfg: config(), token: null, http: routedHttp({}, { record }), since: SINCE, now: NOW }),
    /no Azure DevOps token/,
  );
  assert.equal(record.length, 0);
});

test('whoami resolves identity from the profile endpoint', async () => {
  const http = routedHttp({ 'profiles/me': fx.ME });
  const id = await whoami({ token: 't', http });
  assert.equal(id.id, fx.ME.id);
  assert.equal(id.email, fx.ME.emailAddress);
});

test('an org given as a full URL and as a bare name resolve identically', async () => {
  const record = [];
  const http = routedHttp(fullRoutes(), { record });
  await fetchAzureDevOpsEvents({ cfg: config(), token: 't', http, since: SINCE, now: NOW });
  const first = record.filter((u) => u.includes('dev.azure.com')).length;

  record.length = 0;
  await fetchAzureDevOpsEvents({
    cfg: config({}), token: 't', http: routedHttp(fullRoutes(), { record }), since: SINCE, now: NOW,
  });
  assert.equal(record.filter((u) => u.includes('dev.azure.com')).length, first);
  assert.ok(record.every((u) => u.startsWith('https://dev.azure.com/fabrikam/') || u.startsWith('https://vsrm.dev.azure.com/fabrikam/')));
});
