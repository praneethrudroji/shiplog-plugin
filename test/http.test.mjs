import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpClient, HttpError, AuthError, linkNext } from '../lib/http.mjs';

function res(status, { body = '', headers = {} } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    text: async () => body,
  };
}

/** Returns a fetcher that replays the given responses, recording calls. */
function scripted(responses) {
  const calls = [];
  const fetcher = async (url, opts) => {
    calls.push({ url, opts });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected extra request to ${url}`);
    return next;
  };
  return { fetcher, calls };
}

const noSleep = () => { const waits = []; return { waits, sleep: async (ms) => { waits.push(ms); } }; };

test('a successful response is parsed as JSON', async () => {
  const { fetcher } = scripted([res(200, { body: '{"hello":"world"}' })]);
  const http = createHttpClient({ fetcher });
  const { body } = await http.request('https://example.test/x');
  assert.deepEqual(body, { hello: 'world' });
});

test('an empty body yields null rather than a parse error', async () => {
  const { fetcher } = scripted([res(204)]);
  const http = createHttpClient({ fetcher });
  assert.equal((await http.request('https://example.test/x')).body, null);
});

test('a 401 is an AuthError and is not retried', async () => {
  const { fetcher, calls } = scripted([res(401, { body: 'bad credentials' })]);
  const http = createHttpClient({ fetcher });
  await assert.rejects(() => http.request('https://example.test/x'), AuthError);
  assert.equal(calls.length, 1, 'must not retry a credential failure');
});

test('a 403 without rate-limit headers is treated as a permission problem', async () => {
  const { fetcher, calls } = scripted([res(403, { body: 'insufficient scope' })]);
  const http = createHttpClient({ fetcher });
  await assert.rejects(() => http.request('https://example.test/x'), AuthError);
  assert.equal(calls.length, 1);
});

test('a 403 with an exhausted rate limit waits and retries instead of failing', async () => {
  const resetAt = Math.floor(Date.now() / 1000) + 30;
  const { fetcher, calls } = scripted([
    res(403, { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetAt) } }),
    res(200, { body: '{"ok":true}' }),
  ]);
  const { waits, sleep } = noSleep();
  const http = createHttpClient({ fetcher, sleep });

  const { body } = await http.request('https://example.test/x');
  assert.deepEqual(body, { ok: true });
  assert.equal(calls.length, 2);
  assert.ok(waits[0] > 25_000 && waits[0] <= 30_000, `waited ${waits[0]}ms`);
});

test('throttling does not consume the retry budget', async () => {
  const resetAt = Math.floor(Date.now() / 1000) + 1;
  const throttle = () => res(403, { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetAt) } });
  const { fetcher, calls } = scripted([throttle(), throttle(), throttle(), throttle(), throttle(), throttle(), res(200, { body: '{}' })]);
  const { sleep } = noSleep();
  const http = createHttpClient({ fetcher, sleep, maxRetries: 2 });

  await http.request('https://example.test/x');
  assert.equal(calls.length, 7, 'six throttles then success, despite maxRetries=2');
});

test('an absurdly long rate-limit wait fails fast rather than hanging the nightly job', async () => {
  const resetAt = Math.floor(Date.now() / 1000) + 7200;
  const { fetcher } = scripted([res(403, { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetAt) } })]);
  const { sleep } = noSleep();
  const http = createHttpClient({ fetcher, sleep });
  await assert.rejects(() => http.request('https://example.test/x'), /rate limited for \d+s/);
});

test('5xx responses retry with exponential backoff, then give up', async () => {
  const { fetcher, calls } = scripted([res(500), res(502), res(503), res(500), res(500)]);
  const { waits, sleep } = noSleep();
  const http = createHttpClient({ fetcher, sleep, maxRetries: 4 });

  await assert.rejects(() => http.request('https://example.test/x'), HttpError);
  assert.equal(calls.length, 5, 'initial attempt plus four retries');
  assert.deepEqual(waits, [1000, 2000, 4000, 8000]);
});

test('a 5xx that recovers returns the eventual success', async () => {
  const { fetcher } = scripted([res(503), res(200, { body: '{"recovered":true}' })]);
  const { sleep } = noSleep();
  const http = createHttpClient({ fetcher, sleep });
  assert.deepEqual((await http.request('https://example.test/x')).body, { recovered: true });
});

test('a 404 is not retried', async () => {
  const { fetcher, calls } = scripted([res(404)]);
  const http = createHttpClient({ fetcher });
  await assert.rejects(() => http.request('https://example.test/x'), HttpError);
  assert.equal(calls.length, 1);
});

test('Retry-After in seconds is honored', async () => {
  const { fetcher } = scripted([res(429, { headers: { 'retry-after': '12' } }), res(200, { body: '{}' })]);
  const { waits, sleep } = noSleep();
  const http = createHttpClient({ fetcher, sleep });
  await http.request('https://example.test/x');
  assert.equal(waits[0], 12_000);
});

test('a JSON body is serialized and content-type set', async () => {
  const { fetcher, calls } = scripted([res(200, { body: '{}' })]);
  const http = createHttpClient({ fetcher });
  await http.request('https://example.test/x', { method: 'POST', body: { query: 'wiql' } });
  assert.equal(calls[0].opts.body, '{"query":"wiql"}');
  assert.equal(calls[0].opts.headers['content-type'], 'application/json');
});

test('pagination follows until next returns null', async () => {
  const { fetcher } = scripted([
    res(200, { body: '[1,2]', headers: { link: '<https://example.test/x?page=2>; rel="next"' } }),
    res(200, { body: '[3,4]', headers: { link: '<https://example.test/x?page=3>; rel="next"' } }),
    res(200, { body: '[5]' }),
  ]);
  const http = createHttpClient({ fetcher });
  const pages = await http.paginate('https://example.test/x', { next: (r) => linkNext(r.headers) });
  assert.deepEqual(pages.flat(), [1, 2, 3, 4, 5]);
});

test('pagination stops at maxPages so a paging bug cannot loop forever', async () => {
  const fetcher = async () => res(200, { body: '[1]', headers: { link: '<https://example.test/same>; rel="next"' } });
  const http = createHttpClient({ fetcher });
  const pages = await http.paginate('https://example.test/x', { next: (r) => linkNext(r.headers), maxPages: 3 });
  assert.equal(pages.length, 3);
});

test('linkNext ignores other rel values', () => {
  const headers = { get: () => '<https://a.test?page=9>; rel="last", <https://a.test?page=2>; rel="next"' };
  assert.equal(linkNext(headers), 'https://a.test?page=2');
  assert.equal(linkNext({ get: () => '<https://a.test?page=9>; rel="last"' }), null);
  assert.equal(linkNext({ get: () => null }), null);
});
