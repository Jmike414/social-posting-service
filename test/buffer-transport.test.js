'use strict';

// Set a key BEFORE requiring config so the transport is enabled.
process.env.BUFFER_API_KEY = 'test-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const { gql, parseRateLimit, createPost, BufferError } = require('../src/publisher/buffer-client');

function fakeRes({ status = 200, body = {}, headers = {} } = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    headers: { get: (k) => (h.has(k.toLowerCase()) ? h.get(k.toLowerCase()) : null) },
    text: async () => JSON.stringify(body),
  };
}

test('parseRateLimit reads RateLimit-* headers', () => {
  const rl = parseRateLimit({ get: (k) => ({ 'ratelimit-limit': '3000', 'ratelimit-remaining': '2999', 'ratelimit-reset': '2026-07-01T00:00:00Z' }[k.toLowerCase()] ?? null) });
  assert.equal(rl.limit, 3000);
  assert.equal(rl.remaining, 2999);
  assert.equal(rl.reset, '2026-07-01T00:00:00Z');
});

test('429 -> RATE_LIMIT (retryable) with retryAfter', async () => {
  const fetchImpl = async () => fakeRes({ status: 429, body: { errors: [{ extensions: { code: 'RATE_LIMIT_EXCEEDED', retryAfter: 7 } }] } });
  await assert.rejects(() => gql('q', {}, { fetchImpl }), (e) => {
    assert.ok(e instanceof BufferError);
    assert.equal(e.code, 'RATE_LIMIT');
    assert.equal(e.retryable, true);
    assert.equal(e.retryAfter, 7);
    return true;
  });
});

test('5xx -> SERVER_ERROR (retryable)', async () => {
  const fetchImpl = async () => fakeRes({ status: 503, body: { message: 'down' } });
  await assert.rejects(() => gql('q', {}, { fetchImpl }), (e) => e.code === 'SERVER_ERROR' && e.retryable === true);
});

test('200 with GraphQL errors -> GRAPHQL_ERROR (not retryable), raw preserved', async () => {
  const fetchImpl = async () => fakeRes({ status: 200, body: { errors: [{ message: 'bad field' }] } });
  await assert.rejects(() => gql('q', {}, { fetchImpl }), (e) => {
    assert.equal(e.code, 'GRAPHQL_ERROR');
    assert.equal(e.retryable, false);
    assert.equal(e.graphqlErrors[0].message, 'bad field');
    return true;
  });
});

test('200 with extensions RATE_LIMIT_EXCEEDED -> reclassified as RATE_LIMIT', async () => {
  const fetchImpl = async () => fakeRes({ status: 200, body: { errors: [{ extensions: { code: 'RATE_LIMIT_EXCEEDED' } }] } });
  await assert.rejects(() => gql('q', {}, { fetchImpl }), (e) => e.code === 'RATE_LIMIT' && e.retryable === true);
});

test('createPost returns post on PostActionSuccess', async () => {
  const fetchImpl = async () => fakeRes({ status: 200, body: { data: { createPost: { __typename: 'PostActionSuccess', post: { id: 'p1', status: 'buffer' } } } } });
  const r = await createPost({ channelId: 'c1', assets: [] }, { fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.post.id, 'p1');
});

test('createPost throws on MutationError', async () => {
  const fetchImpl = async () => fakeRes({ status: 200, body: { data: { createPost: { __typename: 'MutationError', message: 'no channel' } } } });
  await assert.rejects(() => createPost({ channelId: 'c1', assets: [] }, { fetchImpl }), (e) => e.code === 'GRAPHQL_ERROR');
});
