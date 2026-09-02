export class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} for ${url}${body ? `: ${String(body).slice(0, 300)}` : ''}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.retryable = status >= 500 || status === 429 || status === 408;
  }
}

/** 401/403 mean the token is wrong or under-scoped - retrying cannot fix that. */
export class AuthError extends HttpError {
  constructor(status, url, body) {
    super(status, url, body);
    this.name = 'AuthError';
    this.retryable = false;
  }
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

function retryAfterMs(headers, now) {
  const retryAfter = headers.get?.('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return seconds * 1000;
    const at = Date.parse(retryAfter);
    if (!Number.isNaN(at)) return Math.max(0, at - now);
  }
  // GitHub and Azure DevOps both expose a reset epoch when the budget is exhausted.
  const remaining = headers.get?.('x-ratelimit-remaining');
  const reset = headers.get?.('x-ratelimit-reset');
  if (remaining === '0' && reset) {
    const at = Number(reset) * 1000;
    if (Number.isFinite(at)) return Math.max(0, at - now);
  }
  return null;
}

export function createHttpClient({
  fetcher = globalThis.fetch,
  sleep = sleepMs,
  maxRetries = 4,
  maxWaitMs = 15 * 60_000,
  log = () => {},
  now = () => Date.now(),
} = {}) {
  async function request(url, { method = 'GET', headers = {}, body, accept = 'application/json' } = {}) {
    let attempt = 0;
    for (;;) {
      const res = await fetcher(url, {
        method,
        headers: { accept, ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
      });

      if (res.status === 401 || res.status === 403) {
        const wait = retryAfterMs(res.headers, now());
        // A 403 with a rate-limit reset is throttling, not a permission problem.
        if (wait === null) throw new AuthError(res.status, url, await safeText(res));
        if (wait > maxWaitMs) throw new HttpError(res.status, url, `rate limited for ${Math.round(wait / 1000)}s`);
        log(`rate limited; waiting ${Math.round(wait / 1000)}s`);
        await sleep(wait);
        continue;   // throttling does not consume a retry
      }

      if (res.ok) {
        const text = await safeText(res);
        return {
          status: res.status,
          headers: res.headers,
          body: text ? JSON.parse(text) : null,
        };
      }

      const err = new HttpError(res.status, url, await safeText(res));
      if (!err.retryable || attempt >= maxRetries) throw err;

      const wait = retryAfterMs(res.headers, now()) ?? Math.min(30_000, 2 ** attempt * 1000);
      attempt += 1;
      log(`${res.status} from ${url}; retry ${attempt}/${maxRetries} in ${Math.round(wait / 1000)}s`);
      await sleep(wait);
    }
  }

  /** Walks pages until `next` returns null. Bounded so a paging bug cannot loop forever. */
  async function paginate(firstUrl, { next, maxPages = 20, ...opts } = {}) {
    const pages = [];
    let url = firstUrl;
    for (let i = 0; url && i < maxPages; i += 1) {
      const res = await request(url, opts);
      pages.push(res.body);
      url = next(res, i);
    }
    return pages;
  }

  return { request, paginate };
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/** Parses a Link header's rel="next", which GitHub uses for pagination. */
export function linkNext(headers) {
  const link = headers.get?.('link');
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (m) return m[1];
  }
  return null;
}
