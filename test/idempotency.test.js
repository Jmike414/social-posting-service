'use strict';

process.env.BUFFER_API_KEY = 'test-key';
process.env.BUFFER_ORGANIZATION_ID = 'org_test';

const test = require('node:test');
const assert = require('node:assert/strict');
const realClient = require('../src/publisher/buffer-client');
const { BufferPublisher } = require('../src/publisher/BufferPublisher');
const { makeStore } = require('./helpers');

function makeClient(overrides) {
  return {
    buildCreatePostInput: realClient.buildCreatePostInput,
    buildImageAsset: realClient.buildImageAsset,
    resolveOrganizationId: async () => 'org_test',
    findPostByText: async () => null,
    createPost: async () => ({ ok: true, post: { id: 'should-not-be-called' } }),
    getPost: async () => null,
    ...overrides,
  };
}

test('fresh post submits once per channel and stores Buffer ids', async () => {
  const store = await makeStore();
  let n = 0;
  const client = makeClient({ createPost: async () => ({ ok: true, post: { id: `p${++n}` } }) });
  const pub = new BufferPublisher({ store, client, sleep: async () => {} });
  const post = await store.createPost({ brand: 'propzombie', brief: 'b', copy: 'hello', state: 'queued', channel_ids: ['c1', 'c2'] });

  const r = await pub.publish(await store.getPost(post.id));
  assert.equal(r.allSubmitted, true);
  assert.equal(n, 2);
  assert.deepEqual((await store.getPost(post.id)).buffer_post_ids, { c1: 'p1', c2: 'p2' });
  await store.close();
});

test('post with stored Buffer ids is NEVER resubmitted', async () => {
  const store = await makeStore();
  let calls = 0;
  const client = makeClient({ createPost: async () => { calls++; return { ok: true, post: { id: 'new' } }; } });
  const pub = new BufferPublisher({ store, client, sleep: async () => {} });
  const post = await store.createPost({
    brand: 'propzombie', brief: 'b', copy: 'hello', state: 'queued',
    channel_ids: ['c1', 'c2'], buffer_post_ids: { c1: 'existing1', c2: 'existing2' },
  });

  const r = await pub.publish(await store.getPost(post.id));
  assert.equal(calls, 0, 'createPost must not be called when all ids already stored');
  assert.equal(r.allSubmitted, true);
  await store.close();
});

test('crash recovery: previously-attempted job adopts an existing Buffer post instead of double-posting', async () => {
  const store = await makeStore();
  const created = [];
  const client = makeClient({
    findPostByText: async ({ channelId, text }) => (channelId === 'c1' && text === 'hello' ? { id: 'recovered1', text } : null),
    createPost: async (input) => { created.push(input.channelId); return { ok: true, post: { id: 'fresh2' } }; },
  });
  const pub = new BufferPublisher({ store, client, sleep: async () => {} });
  const post = await store.createPost({ brand: 'propzombie', brief: 'b', copy: 'hello', state: 'posting', attempts: 1, channel_ids: ['c1', 'c2'] });

  const r = await pub.publish(await store.getPost(post.id));
  assert.deepEqual(created, ['c2'], 'only c2 is submitted; c1 is recovered');
  assert.equal(r.bufferPostIds.c1, 'recovered1');
  assert.equal(r.bufferPostIds.c2, 'fresh2');
  await store.close();
});
