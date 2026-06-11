'use strict';

process.env.BUFFER_API_KEY = 'test-key';
process.env.BUFFER_ORGANIZATION_ID = 'org_test';

const test = require('node:test');
const assert = require('node:assert/strict');
const realClient = require('../src/publisher/buffer-client');
const { BufferError } = realClient;
const { BufferPublisher } = require('../src/publisher/BufferPublisher');
const { makeStore } = require('./helpers');

function client(createPost) {
  return {
    buildCreatePostInput: realClient.buildCreatePostInput,
    buildImageAsset: realClient.buildImageAsset,
    resolveOrganizationId: async () => 'org_test',
    findPostByText: async () => null,
    createPost,
  };
}

test('retries transient 5xx and succeeds within 3 attempts', async () => {
  const store = await makeStore();
  let attempts = 0;
  const delays = [];
  const pub = new BufferPublisher({
    store,
    client: client(async () => {
      attempts++;
      if (attempts < 3) throw new BufferError('boom', { code: 'SERVER_ERROR', status: 503 });
      return { ok: true, post: { id: 'ok' } };
    }),
    sleep: async (ms) => { delays.push(ms); },
    baseDelayMs: 100,
  });
  const post = await store.createPost({ brand: 'propzombie', brief: 'b', copy: 'x', state: 'queued', channel_ids: ['c1'] });
  const r = await pub.publish(await store.getPost(post.id));
  assert.equal(r.allSubmitted, true);
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [100, 200], 'exponential backoff: 100ms then 200ms');
  await store.close();
});

test('gives up after max 3 attempts on persistent rate-limit and throws', async () => {
  const store = await makeStore();
  let attempts = 0;
  const pub = new BufferPublisher({
    store,
    client: client(async () => { attempts++; throw new BufferError('429', { code: 'RATE_LIMIT', retryAfter: 1 }); }),
    sleep: async () => {},
  });
  const post = await store.createPost({ brand: 'propzombie', brief: 'b', copy: 'x', state: 'queued', channel_ids: ['c1'] });
  await assert.rejects(() => pub.publish(post), (e) => e.code === 'RATE_LIMIT');
  assert.equal(attempts, 3, 'exactly maxAttempts tries');
  await store.close();
});

test('hard error (validation) fails fast — no retry', async () => {
  const store = await makeStore();
  let attempts = 0;
  const pub = new BufferPublisher({
    store,
    client: client(async () => { attempts++; throw new BufferError('bad', { code: 'GRAPHQL_ERROR' }); }),
    sleep: async () => {},
  });
  const post = await store.createPost({ brand: 'propzombie', brief: 'b', copy: 'x', state: 'queued', channel_ids: ['c1'] });
  await assert.rejects(() => pub.publish(post), (e) => e.code === 'GRAPHQL_ERROR');
  assert.equal(attempts, 1, 'non-retryable errors are not retried');
  await store.close();
});
