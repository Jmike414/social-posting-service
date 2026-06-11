'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDrafter } = require('../src/drafter');
const { processOnce, processQueued } = require('../src/worker');
const { STATES } = require('../src/state');
const { makeStore } = require('./helpers');

const drafter = createDrafter({ client: null }); // force heuristic (offline, deterministic)
const okPublisher = { publish: async (p) => ({ allSubmitted: true, bufferPostIds: Object.fromEntries((p.channel_ids || []).map((c) => [c, `bp_${c}`])) }) };

test('brand -> channel resolution: drafted buffer post stores the brand channel ids', async () => {
  const store = await makeStore();
  await store.setChannels('propzombie', [
    { id: 'fb_123', service: 'facebook', name: 'PropZombie Page' },
    { id: 'ig_456', service: 'instagram', name: 'PropZombie IG' },
  ]);
  assert.deepEqual(await store.resolveChannelsForBrand('crewmando'), []);

  const post = await store.createPost({ brand: 'propzombie', brief: 'new deal', destination: 'buffer', state: STATES.DRAFTED });
  await processOnce({ store, drafter, publisher: okPublisher });
  const after = await store.getPost(post.id);
  assert.deepEqual(after.channel_ids, ['fb_123', 'ig_456']);
  await store.close();
});

test('auto_publish=false routes drafted -> awaiting_review (human gate)', async () => {
  const store = await makeStore();
  await store.setChannels('propzombie', [{ id: 'fb_1', service: 'facebook' }]);
  const post = await store.createPost({ brand: 'propzombie', brief: 'x', state: STATES.DRAFTED, auto_publish: false });
  await processOnce({ store, drafter, publisher: okPublisher });
  const after = await store.getPost(post.id);
  assert.equal(after.state, STATES.AWAITING_REVIEW);
  assert.ok(after.copy, 'copy was drafted');
  await store.close();
});

test('auto_publish=true bypasses review: drafted -> queued -> published in one run', async () => {
  const store = await makeStore();
  await store.setChannels('propzombie', [{ id: 'fb_1', service: 'facebook' }]);
  const post = await store.createPost({ brand: 'propzombie', brief: 'x', state: STATES.DRAFTED, auto_publish: true });
  await processOnce({ store, drafter, publisher: okPublisher }); // drafts -> queued
  await processOnce({ store, drafter, publisher: okPublisher }); // publishes
  const after = await store.getPost(post.id);
  assert.equal(after.state, STATES.PUBLISHED);
  assert.deepEqual(after.buffer_post_ids, { fb_1: 'bp_fb_1' });
  await store.close();
});

test('manual destination routes straight to human_post_queue (never touches Buffer)', async () => {
  const store = await makeStore();
  const post = await store.createPost({ brand: 'crewmando', brief: 'need a framing crew', destination: 'manual_fb_group', state: STATES.DRAFTED });
  await processOnce({ store, drafter, publisher: okPublisher });
  assert.equal((await store.getPost(post.id)).state, STATES.MANUAL);
  const hpq = await store.listHumanPosts({ status: 'pending' });
  assert.equal(hpq.length, 1);
  assert.equal(hpq[0].platform, 'fb_group');
  assert.equal(hpq[0].source_post_id, post.id);
  await store.close();
});

test('failure path: poster error routes the post to human_post_queue with the verbatim error', async () => {
  const store = await makeStore();
  await store.setChannels('propzombie', [{ id: 'fb_1', service: 'facebook' }]);
  const failing = { publish: async () => { const e = new Error('429 exhausted'); e.code = 'RATE_LIMIT'; e.graphqlErrors = [{ extensions: { code: 'RATE_LIMIT_EXCEEDED' } }]; throw e; } };
  const post = await store.createPost({ brand: 'propzombie', brief: 'x', copy: 'ready', state: STATES.QUEUED, channel_ids: ['fb_1'] });

  await processQueued(await store.getPost(post.id), { store, publisher: failing });
  const after = await store.getPost(post.id);
  assert.equal(after.state, STATES.FAILED);
  assert.match(after.error, /RATE_LIMIT/);

  const hpq = await store.listHumanPosts({ status: 'pending' });
  assert.equal(hpq.length, 1);
  assert.equal(hpq[0].platform, 'failed_buffer');
  assert.match(hpq[0].error, /RATE_LIMIT_EXCEEDED/, 'verbatim GraphQL error payload retained');
  await store.close();
});
