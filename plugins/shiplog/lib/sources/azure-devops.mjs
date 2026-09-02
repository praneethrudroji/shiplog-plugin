import { shouldEnrich } from '../temporal/prefilter.mjs';

export const SOURCE = 'azure_devops';
const PROFILE_API = 'https://app.vssps.visualstudio.com';
const API_VERSION = '7.1';

const authHeader = (pat) => ({ authorization: `Basic ${Buffer.from(`:${pat}`).toString('base64')}` });
const truncate = (text, max) => (text && text.length > max ? `${text.slice(0, max)}…` : text ?? null);

function orgName(orgUrl) {
  // Accepts either a bare org name or a full https://dev.azure.com/{org} URL.
  const m = /dev\.azure\.com\/([^/]+)/i.exec(orgUrl ?? '');
  return m ? m[1] : orgUrl;
}

function orgBase(orgUrl) {
  return `https://dev.azure.com/${orgName(orgUrl)}`;
}

function releaseBase(orgUrl) {
  return `https://vsrm.dev.azure.com/${orgName(orgUrl)}`;
}

function webPrUrl(org, project, repo, id) {
  return `${orgBase(org)}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}/pullrequest/${id}`;
}

function webWorkItemUrl(org, project, id) {
  return `${orgBase(org)}/${encodeURIComponent(project)}/_workitems/edit/${id}`;
}

/**
 * Comment/description text can be attributed to a date other than its posted time;
 * a merge, close, or revision timestamp is already precise and must never be
 * reinterpreted.
 */
const enrichFlag = (body) => (shouldEnrich(body) ? 1 : 0);

export function normalizePullRequest(pr, { org, maxBodyChars = 2000, syncedAt }) {
  const project = pr.repository?.project?.name;
  const repo = pr.repository?.name;
  const externalId = `${project}/${repo}#${pr.pullRequestId}`;
  const url = webPrUrl(org, project, repo, pr.pullRequestId);
  const base = {
    source: SOURCE, project, repo, url, parent_key: externalId, synced_at: syncedAt, raw_json: pr,
  };

  const events = [{
    ...base,
    event_type: 'pr_opened',
    external_id: externalId,
    title: pr.title,
    body: truncate(pr.description, maxBodyChars),
    status: pr.status,
    occurred_at: pr.creationDate,
    updated_at: pr.creationDate,
    needs_enrichment: enrichFlag(pr.description),
  }];

  if (pr.status === 'completed' && pr.closedDate) {
    events.push({
      ...base,
      event_type: 'pr_merged',
      external_id: externalId,
      title: pr.title,
      body: null,
      status: 'completed',
      occurred_at: pr.closedDate,
      updated_at: pr.closedDate,
      needs_enrichment: 0,
    });
  }
  return events;
}

const VOTE_LABELS = { 10: 'approved', 5: 'approved with suggestions', 0: 'no vote', '-5': 'waiting for author', '-10': 'rejected' };

/**
 * Review "votes" surface only as system-generated thread comments (e.g. "Jane voted
 * 10") - the PR list API's reviewer array carries a vote value but no timestamp, so
 * this is the only place a review actually gets a real occurred_at.
 */
export function normalizeReviewVote(comment, pr, { org, syncedAt }) {
  const project = pr.repository?.project?.name;
  const repo = pr.repository?.name;
  const m = /voted\s+(-?\d+)/i.exec(comment.content ?? '');
  return {
    source: SOURCE,
    event_type: 'pr_reviewed',
    external_id: `pr-vote:${pr.pullRequestId}:${comment.id}:${comment.publishedDate}`,
    project, repo,
    title: pr.title,
    body: null,
    url: webPrUrl(org, project, repo, pr.pullRequestId),
    status: m ? (VOTE_LABELS[m[1]] ?? m[1]) : null,
    parent_key: `${project}/${repo}#${pr.pullRequestId}`,
    occurred_at: comment.publishedDate,
    updated_at: comment.publishedDate,
    raw_json: comment,
    synced_at: syncedAt,
    needs_enrichment: 0,
  };
}

export function normalizePrComment(comment, pr, { org, maxBodyChars = 2000, syncedAt }) {
  const project = pr.repository?.project?.name;
  const repo = pr.repository?.name;
  return {
    source: SOURCE,
    event_type: 'pr_comment',
    external_id: `pr-comment:${comment.id}:${pr.pullRequestId}:${project}/${repo}`,
    project, repo,
    title: pr.title,
    body: truncate(comment.content, maxBodyChars),
    url: webPrUrl(org, project, repo, pr.pullRequestId),
    status: null,
    parent_key: `${project}/${repo}#${pr.pullRequestId}`,
    occurred_at: comment.publishedDate,
    updated_at: comment.publishedDate,
    raw_json: comment,
    synced_at: syncedAt,
    needs_enrichment: enrichFlag(comment.content),
  };
}

export function normalizeWorkItemCreated(item, { org, syncedAt }) {
  const f = item.fields;
  const project = f['System.TeamProject'];
  return {
    source: SOURCE,
    event_type: 'ticket_created',
    external_id: `wi-created:${item.id}`,
    project,
    repo: null,
    title: f['System.Title'],
    body: null,
    url: webWorkItemUrl(org, project, item.id),
    status: f['System.State'],
    parent_key: `${project}#${item.id}`,
    occurred_at: f['System.CreatedDate'],
    updated_at: f['System.CreatedDate'],
    raw_json: item,
    synced_at: syncedAt,
    needs_enrichment: 0,
  };
}

export function normalizeWorkItemComment(comment, item, { org, maxBodyChars = 2000, syncedAt }) {
  const project = item.fields['System.TeamProject'];
  return {
    source: SOURCE,
    event_type: 'ticket_comment',
    external_id: `wi-comment:${comment.id}`,
    project,
    repo: null,
    title: item.fields['System.Title'],
    body: truncate(comment.text, maxBodyChars),
    url: webWorkItemUrl(org, project, item.id),
    status: null,
    parent_key: `${project}#${item.id}`,
    occurred_at: comment.createdDate,
    updated_at: comment.createdDate,
    raw_json: comment,
    synced_at: syncedAt,
    needs_enrichment: enrichFlag(comment.text),
  };
}

// Azure DevOps sets `revisedDate` to this sentinel on a work item's current
// revision, meaning "not superseded yet" rather than any real date.
const REVISED_DATE_SENTINEL_YEAR = '9999';

/**
 * When a revision's change actually happened.
 *
 * Not `revisedDate`, which is a trap in two separate ways, both confirmed against a
 * live work item rather than inferred. On the newest revision it is the year-9999
 * sentinel above. On every older revision it is the moment that revision stopped
 * being current, which is to say the timestamp of the *next* edit: a ticket moved to
 * Done on Friday and next touched three weeks later records the transition three
 * weeks late. For a tool whose entire question is "when did I do this", that is the
 * wrong date twice over.
 *
 * `System.ChangedDate` on the same revision is when the change was made, which is
 * what this needs. `revisedDate` is kept only as a fallback, and only when it is not
 * the sentinel.
 */
export function statusChangeDate(update) {
  const changed = update.fields?.['System.ChangedDate']?.newValue;
  if (changed) return changed;

  const revised = update.revisedDate;
  if (revised && !String(revised).startsWith(REVISED_DATE_SENTINEL_YEAR)) return revised;

  return null;
}

/** A genuine transition has an oldValue; the creation revision (rev 1) does not. */
export function normalizeStatusChange(update, item, { org, syncedAt }) {
  const change = update.fields?.['System.State'];
  if (!change || change.oldValue === undefined) return null;

  // No usable timestamp means no defensible date to attribute the work to. Dropping
  // the row is better than inventing one: a wrong date in a record meant to serve as
  // evidence is worse than a missing one.
  const occurredAt = statusChangeDate(update);
  if (!occurredAt) return null;

  const project = item.fields['System.TeamProject'];
  return {
    source: SOURCE,
    event_type: 'ticket_status_change',
    external_id: `wi-status:${item.id}:${update.rev}`,
    project,
    repo: null,
    title: item.fields['System.Title'],
    body: `${change.oldValue} → ${change.newValue}`,
    url: webWorkItemUrl(org, project, item.id),
    status: change.newValue,
    parent_key: `${project}#${item.id}`,
    occurred_at: occurredAt,
    updated_at: occurredAt,
    raw_json: update,
    synced_at: syncedAt,
    needs_enrichment: 0,
  };
}

/**
 * Covers Classic Release Management pipelines only - YAML pipeline environment
 * approvals have no equivalent REST endpoint (see docs/DECISIONS.md); this is a
 * documented v1 gap rather than silently missing data.
 */
export function normalizeDeployment(dep, { org, project, syncedAt }) {
  const occurredAt = dep.completedOn ?? dep.lastModifiedOn ?? dep.startedOn;
  return {
    source: SOURCE,
    event_type: 'deployment_request',
    external_id: `deployment:${dep.id}`,
    project,
    repo: null,
    title: `${dep.release?.name ?? 'Release'} → ${dep.releaseEnvironment?.name ?? 'environment'}`,
    body: null,
    url: dep.release?.id
      ? `${orgBase(org)}/_release?releaseId=${dep.release.id}&_a=release-summary`
      : dep.url,
    status: dep.deploymentStatus,
    parent_key: dep.release?.id ? `release:${dep.release.id}` : null,
    occurred_at: occurredAt,
    updated_at: dep.lastModifiedOn ?? occurredAt,
    raw_json: dep,
    synced_at: syncedAt,
    needs_enrichment: 0,
  };
}

async function pagedValue(http, url, opts) {
  const { body } = await http.request(url, opts);
  return body?.value ?? [];
}

export async function fetchAzureDevOpsEvents({ cfg, token, http, since, now = new Date(), log = () => {} }) {
  const settings = cfg.sources?.azure_devops ?? {};
  const userId = cfg.identity?.adoUserId;
  if (!userId) throw new Error('identity.adoUserId is not set - run /shiplog-setup');
  if (!token) throw new Error('no Azure DevOps token available');
  if (!settings.orgUrl) throw new Error('azure_devops.orgUrl is not configured');

  const org = settings.orgUrl;
  const maxBodyChars = cfg.sync?.maxBodyChars ?? 2000;
  const syncedAt = now.toISOString();
  const opts = { headers: authHeader(token) };
  const events = [];
  const sinceDay = since.slice(0, 10);

  for (const project of settings.projects ?? []) {
    const base = orgBase(org);
    const p = encodeURIComponent(project);

    // 1. PRs I created, plus, for each, its thread comments (my comments + my votes).
    const created = await pagedValue(
      http, `${base}/${p}/_apis/git/pullrequests?searchCriteria.creatorId=${userId}&searchCriteria.status=all&searchCriteria.minTime=${encodeURIComponent(since)}&api-version=${API_VERSION}`, opts,
    );
    log(`azure_devops[${project}]: ${created.length} authored PRs`);

    // 2. PRs I reviewed (may or may not overlap with 1) - needed to find my votes/comments there too.
    const reviewed = await pagedValue(
      http, `${base}/${p}/_apis/git/pullrequests?searchCriteria.reviewerId=${userId}&searchCriteria.status=all&searchCriteria.minTime=${encodeURIComponent(since)}&api-version=${API_VERSION}`, opts,
    );
    log(`azure_devops[${project}]: ${reviewed.length} reviewed PRs`);

    for (const pr of created) {
      for (const e of normalizePullRequest(pr, { org, maxBodyChars, syncedAt })) {
        if (e.occurred_at >= since) events.push(e);
      }
    }

    const byId = new Map([...created, ...reviewed].map((pr) => [pr.pullRequestId, pr]));
    for (const pr of byId.values()) {
      const repoId = pr.repository?.id;
      if (!repoId) continue;
      const threads = await pagedValue(
        http, `${base}/${p}/_apis/git/repositories/${repoId}/pullRequests/${pr.pullRequestId}/threads?api-version=${API_VERSION}`, opts,
      );
      for (const thread of threads) {
        for (const comment of thread.comments ?? []) {
          if (comment.author?.id !== userId || comment.publishedDate < since) continue;
          if (comment.commentType === 'text') events.push(normalizePrComment(comment, pr, { org, maxBodyChars, syncedAt }));
          else if (comment.commentType === 'system' && /voted/i.test(comment.content ?? '')) {
            events.push(normalizeReviewVote(comment, pr, { org, syncedAt }));
          }
        }
      }
    }

    // 3. Work items I've touched: WIQL finds the ids, a batch call fetches the fields.
    const wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.ChangedBy] = @Me AND [System.ChangedDate] >= '${sinceDay}' ORDER BY [System.ChangedDate] DESC`;
    const { body: wiqlResult } = await http.request(`${base}/${p}/_apis/wit/wiql?api-version=${API_VERSION}`, {
      ...opts, method: 'POST', body: { query: wiql },
    });
    const ids = (wiqlResult?.workItems ?? []).map((w) => w.id);
    log(`azure_devops[${project}]: ${ids.length} work items changed by me`);

    if (ids.length) {
      const { body: batch } = await http.request(`${base}/${p}/_apis/wit/workitemsbatch?api-version=${API_VERSION}`, {
        ...opts,
        method: 'POST',
        body: {
          ids,
          fields: ['System.Id', 'System.Title', 'System.State', 'System.WorkItemType', 'System.TeamProject', 'System.CreatedDate', 'System.CreatedBy', 'System.ChangedDate'],
        },
      });

      for (const item of batch?.value ?? []) {
        if (item.fields['System.CreatedBy']?.id === userId && item.fields['System.CreatedDate'] >= since) {
          events.push(normalizeWorkItemCreated(item, { org, syncedAt }));
        }

        const comments = await pagedValueComments(http, `${base}/${p}/_apis/wit/workItems/${item.id}/comments?api-version=7.1-preview.4`, opts);
        for (const c of comments) {
          if (c.createdBy?.id === userId && c.createdDate >= since) events.push(normalizeWorkItemComment(c, item, { org, maxBodyChars, syncedAt }));
        }

        const updates = await pagedValue(http, `${base}/${p}/_apis/wit/workItems/${item.id}/updates?api-version=${API_VERSION}`, opts);
        for (const u of updates) {
          if (u.revisedBy?.id !== userId || u.revisedDate < since) continue;
          const e = normalizeStatusChange(u, item, { org, syncedAt });
          if (e) events.push(e);
        }
      }
    }

    // 4. Deployment requests (Classic Release pipelines only - see docs/DECISIONS.md).
    if (settings.includeDeployments !== false) {
      const deployments = await pagedValue(
        http, `${releaseBase(org)}/${p}/_apis/release/deployments?createdFor=${userId}&api-version=${API_VERSION}`, opts,
      );
      log(`azure_devops[${project}]: ${deployments.length} deployment requests`);
      for (const dep of deployments) {
        const e = normalizeDeployment(dep, { org, project, syncedAt });
        if (e.occurred_at && e.occurred_at >= since) events.push(e);
      }
    }
  }

  return { events, cursor: syncedAt };
}

/** The comments endpoint uses continuationToken paging, distinct from the Link-header style elsewhere. */
async function pagedValueComments(http, firstUrl, opts) {
  const out = [];
  let url = firstUrl;
  for (let i = 0; url && i < 20; i += 1) {
    const { body } = await http.request(url, opts);
    out.push(...(body?.comments ?? []));
    url = body?.continuationToken
      ? `${firstUrl}${firstUrl.includes('?') ? '&' : '?'}continuationToken=${encodeURIComponent(body.continuationToken)}`
      : null;
  }
  return out;
}

/** Resolves the current user's profile once at setup, so identity is never hand-typed. */
export async function whoami({ token, http }) {
  const { body } = await http.request(`${PROFILE_API}/_apis/profile/profiles/me?api-version=${API_VERSION}`, { headers: authHeader(token) });
  return { id: body.id, displayName: body.displayName, email: body.emailAddress };
}
