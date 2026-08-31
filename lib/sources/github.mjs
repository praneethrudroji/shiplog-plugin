import { linkNext } from '../http.mjs';
import { shouldEnrich } from '../temporal/prefilter.mjs';

export const SOURCE = 'github';
const API = 'https://api.github.com';
const PER_PAGE = 100;

const headersFor = (token) => ({
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
});

function repoFrom(item) {
  // Search results carry the repo only as an API URL.
  const m = /\/repos\/([^/]+)\/([^/]+)$/.exec(item.repository_url ?? '');
  return m ? { owner: m[1], repo: m[2] } : { owner: null, repo: null };
}

const truncate = (text, max) => (text && text.length > max ? `${text.slice(0, max)}…` : text ?? null);

/**
 * Comment and description text can be attributed to a date other than its posted
 * time; a merge or commit timestamp is already precise and must never be reinterpreted.
 */
function enrichFlag(eventType, body) {
  const eligible = eventType === 'pr_comment' || eventType === 'ticket_comment' || eventType === 'pr_opened';
  return eligible && shouldEnrich(body) ? 1 : 0;
}

export function normalizePullRequest(item, { maxBodyChars = 2000, syncedAt }) {
  const { owner, repo } = repoFrom(item);
  const events = [];
  const base = {
    source: SOURCE,
    project: owner,
    repo,
    url: item.html_url,
    parent_key: repo ? `${owner}/${repo}#${item.number}` : null,
    synced_at: syncedAt,
    raw_json: item,
  };

  events.push({
    ...base,
    event_type: 'pr_opened',
    external_id: `${owner}/${repo}#${item.number}`,
    title: item.title,
    body: truncate(item.body, maxBodyChars),
    status: item.state,
    occurred_at: item.created_at,
    updated_at: item.updated_at,
    needs_enrichment: enrichFlag('pr_opened', item.body),
  });

  const mergedAt = item.pull_request?.merged_at;
  if (mergedAt) {
    events.push({
      ...base,
      event_type: 'pr_merged',
      external_id: `${owner}/${repo}#${item.number}`,
      title: item.title,
      body: null,
      status: 'merged',
      occurred_at: mergedAt,
      updated_at: item.updated_at,
      needs_enrichment: 0,
    });
  }
  return events;
}

export function normalizeComment(comment, item, { maxBodyChars = 2000, syncedAt }) {
  const { owner, repo } = repoFrom(item);
  const isPr = Boolean(item.pull_request);
  const eventType = isPr ? 'pr_comment' : 'ticket_comment';
  return {
    source: SOURCE,
    event_type: eventType,
    external_id: `comment:${comment.id}`,
    project: owner,
    repo,
    title: item.title,
    body: truncate(comment.body, maxBodyChars),
    url: comment.html_url,
    status: null,
    parent_key: repo ? `${owner}/${repo}#${item.number}` : null,
    occurred_at: comment.created_at,
    updated_at: comment.updated_at,
    raw_json: comment,
    synced_at: syncedAt,
    needs_enrichment: enrichFlag(eventType, comment.body),
  };
}

export function normalizeReview(review, item, { maxBodyChars = 2000, syncedAt }) {
  const { owner, repo } = repoFrom(item);
  return {
    source: SOURCE,
    event_type: 'pr_reviewed',
    external_id: `review:${review.id}`,
    project: owner,
    repo,
    title: item.title,
    body: truncate(review.body, maxBodyChars),
    url: review.html_url,
    status: review.state,
    parent_key: repo ? `${owner}/${repo}#${item.number}` : null,
    occurred_at: review.submitted_at,
    updated_at: review.submitted_at,
    raw_json: review,
    synced_at: syncedAt,
    needs_enrichment: 0,
  };
}

export function normalizeCommit(item, { syncedAt }) {
  const owner = item.repository?.owner?.login ?? null;
  const repo = item.repository?.name ?? null;
  return {
    source: SOURCE,
    event_type: 'commit',
    external_id: item.sha,
    project: owner,
    repo,
    title: (item.commit?.message ?? '').split('\n')[0].slice(0, 300),
    body: null,
    url: item.html_url,
    status: null,
    parent_key: null,
    occurred_at: item.commit?.author?.date ?? item.commit?.committer?.date,
    updated_at: item.commit?.author?.date ?? null,
    raw_json: item,
    synced_at: syncedAt,
    needs_enrichment: 0,
  };
}

/**
 * `since` is an ISO instant. GitHub's search index lags slightly and only supports
 * `updated`, so results are re-filtered by their own timestamps before being kept.
 */
export async function fetchGitHubEvents({ cfg, token, http, since, now = new Date(), log = () => {} }) {
  const settings = cfg.sources?.github ?? {};
  const login = cfg.identity?.githubLogin;
  if (!login) throw new Error('identity.githubLogin is not set - run /worklog-setup');
  if (!token) throw new Error('no GitHub token available');

  const syncedAt = now.toISOString();
  const maxBodyChars = cfg.sync?.maxBodyChars ?? 2000;
  const opts = { headers: headersFor(token) };
  const orgScope = (settings.orgs ?? []).map((o) => ` org:${o}`).join('');
  const sinceDay = since.slice(0, 10);
  const events = [];

  const searchIssues = async (query) => {
    const url = `${API}/search/issues?q=${encodeURIComponent(query)}&per_page=${PER_PAGE}`;
    const pages = await http.paginate(url, { ...opts, next: (r) => linkNext(r.headers) });
    return pages.flatMap((p) => p?.items ?? []);
  };

  // 1. Pull requests the user opened, and their merges.
  const authored = await searchIssues(`author:${login} type:pr updated:>=${sinceDay}${orgScope}`);
  log(`github: ${authored.length} authored PRs`);
  for (const item of authored) {
    for (const e of normalizePullRequest(item, { maxBodyChars, syncedAt })) {
      if (e.occurred_at >= since) events.push(e);
    }
  }

  // 2. Comments the user wrote. Search finds the threads; the comments themselves
  //    need a second call per thread, which is why the window is kept narrow.
  const commented = await searchIssues(`commenter:${login} updated:>=${sinceDay}${orgScope}`);
  log(`github: ${commented.length} threads with comments`);
  for (const item of commented) {
    const { owner, repo } = repoFrom(item);
    if (!owner) continue;
    const url = `${API}/repos/${owner}/${repo}/issues/${item.number}/comments?since=${encodeURIComponent(since)}&per_page=${PER_PAGE}`;
    const pages = await http.paginate(url, { ...opts, next: (r) => linkNext(r.headers) });
    for (const comment of pages.flat()) {
      if (comment?.user?.login !== login) continue;
      if (comment.created_at < since) continue;
      events.push(normalizeComment(comment, item, { maxBodyChars, syncedAt }));
    }
  }

  // 3. Reviews the user submitted.
  const reviewed = await searchIssues(`reviewed-by:${login} type:pr updated:>=${sinceDay}${orgScope}`);
  log(`github: ${reviewed.length} reviewed PRs`);
  for (const item of reviewed) {
    const { owner, repo } = repoFrom(item);
    if (!owner) continue;
    const url = `${API}/repos/${owner}/${repo}/pulls/${item.number}/reviews?per_page=${PER_PAGE}`;
    const pages = await http.paginate(url, { ...opts, next: (r) => linkNext(r.headers) });
    for (const review of pages.flat()) {
      if (review?.user?.login !== login) continue;
      if (!review.submitted_at || review.submitted_at < since) continue;
      events.push(normalizeReview(review, item, { maxBodyChars, syncedAt }));
    }
  }

  // 4. Commits are opt-in: the commit search endpoint is the most expensive call here.
  if (settings.includeCommits) {
    const url = `${API}/search/commits?q=${encodeURIComponent(`author:${login} author-date:>=${sinceDay}${orgScope}`)}&per_page=${PER_PAGE}`;
    const pages = await http.paginate(url, { ...opts, next: (r) => linkNext(r.headers) });
    for (const item of pages.flatMap((p) => p?.items ?? [])) {
      const e = normalizeCommit(item, { syncedAt });
      if (e.occurred_at && e.occurred_at >= since) events.push(e);
    }
  }

  return { events, cursor: syncedAt };
}

/** Confirms the token works and returns the login, so setup never stores a guess. */
export async function whoami({ token, http }) {
  const { body } = await http.request(`${API}/user`, { headers: headersFor(token) });
  return { login: body.login, name: body.name };
}
