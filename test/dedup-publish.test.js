'use strict';

// [VERIFIED-BY-EXECUTION] Duplicate-publish prevention tests.
//
// Layer 1 — atomic claimPost: only one of two concurrent processOnce callers
//   can claim a given post; the other gets null and skips.
// Layer 2 — buffer_submits UNIQUE constraint: even if Layer 1 somehow fails,
//   the dedup table blocks the second INSERT and the second caller skips.
// Approve — atomic approvePost: two concurrent approvals yield one 200, one 409.

process.env.BUFFER_API_KEY = 'test-key';
process.env.BUFFER_ORGANIZATION_ID = 'org_test';
process.env.CONSOLE_PASSWORD = 'testpass';
process.env.SESSION_SECRET = 'test-secret-session-key-32bytes!';
process.env.PUBLIC_BASE_URL = 'http://localhost:0';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { processOnce, processQueued } = require('../src/worker');
const { STATES } = require('../src/state');
const { BufferPublisher } = require('../src/publisher/BufferPublisher');
const realClient = require('../src/publisher/buffer-client');
const { makeStore } = require('./helpers');
const { createApp } = require('../src/server');

// ── Layer 1: concurrent processOnce → exactly one submit ────────────────────

test('concurrent processOnce: only one Buffer submit when two callers race the same QUEUED post', async () => {
  const store = await makeStore();
  await store.setChannels('propzombie', [{ id: 'fb_1', service: 'facebook' }]);

  let submitCount = 0;
  let resolveFirst;
  const firstSubmitGate = new Promise((r) => { resolveFirst = r; });

  // Slow publisher: first submit waits until the gate is released; this opens a
  // window for the concurrent processOnce call to also attempt to claim.
  const slowClient = {
    buildCreatePostInput: realClient.buildCreatePostInput,
    buildImageAsset: realClient.buildImageAsset,
    buildVideoAsset: realClient.buildVideoAsset || (() => ({})),
    buildPostMetadata: null,
    resolveOrganizationId: async () => 'org_test',
    findPostByText: async () => null,
    createPost: async () => {
      submitCount++;
      await firstSubmitGate; // pause here so concurrent caller can run
      return { ok: true, post: { id: 'bp_slow' } };
    },
  };

  const publisher = new BufferPublisher({ store, client: slowClient, sleep: async () => {} });

  const post = await store.createPost({
    brand: 'propzombie', brief: 'race test', copy: 'race me',
    state: STATES.QUEUED, channel_ids: ['fb_1'],
  });

  // Launch both processOnce calls concurrently.
  const p1 = processOnce({ store, drafter: null, publisher });
  const p2 = processOnce({ store, drafter: null, publisher });

  // Allow the slow publisher to complete after both calls have started.
  resolveFirst();
  await Promise.all([p1, p2]);

  assert.equal(submitCount, 1, 'createPost must be called exactly once despite two concurrent processOnce callers');

  const after = await store.getPost(post.id);
  assert.equal(after.state, STATES.PUBLISHED, 'post must reach published state');
  assert.equal(after.buffer_post_ids['fb_1'], 'bp_slow', 'the one submit must be recorded');

  // buffer_submits should have exactly one completed row.
  const row = await store.getBufferSubmit(post.id, 'fb_1');
  assert.ok(row, 'buffer_submits row must exist');
  assert.equal(row.buffer_post_id, 'bp_slow', 'buffer_post_id must be recorded in dedup table');

  await store.close();
});

// ── Layer 2: buffer_submits UNIQUE constraint blocks second insert ────────────

test('buffer_submits dedup: second insertBufferSubmit for same (post_id, channel_id) returns false', async () => {
  const store = await makeStore();
  const post = await store.createPost({ brand: 'propzombie', brief: 'b', copy: 'c', state: STATES.QUEUED });

  const first = await store.insertBufferSubmit(post.id, 'ch_x');
  const second = await store.insertBufferSubmit(post.id, 'ch_x');

  assert.equal(first, true, 'first insert must succeed');
  assert.equal(second, false, 'second insert for same (post_id, channel_id) must be blocked');

  await store.close();
});

test('buffer_submits dedup: conflict path adopts existing buffer_post_id and skips createPost', async () => {
  const store = await makeStore();
  await store.setChannels('propzombie', [{ id: 'ch_1', service: 'facebook' }]);

  let createCalled = 0;
  const client = {
    buildCreatePostInput: realClient.buildCreatePostInput,
    buildImageAsset: realClient.buildImageAsset,
    buildVideoAsset: realClient.buildVideoAsset || (() => ({})),
    buildPostMetadata: null,
    resolveOrganizationId: async () => 'org_test',
    findPostByText: async () => null,
    createPost: async () => { createCalled++; return { ok: true, post: { id: 'should-not-be-called' } }; },
  };

  const pub = new BufferPublisher({ store, client, sleep: async () => {} });

  const post = await store.createPost({
    brand: 'propzombie', brief: 'b', copy: 'hello',
    state: STATES.QUEUED, channel_ids: ['ch_1'],
  });

  // Pre-seed the dedup table as if another caller already completed the submit.
  await store.insertBufferSubmit(post.id, 'ch_1');
  await store.recordBufferSubmit(post.id, 'ch_1', 'already_done_bp');

  const r = await pub.publish(await store.getPost(post.id));

  assert.equal(createCalled, 0, 'createPost must not be called when dedup table has a completed entry');
  assert.equal(r.bufferPostIds['ch_1'], 'already_done_bp', 'existing buffer_post_id must be adopted');
  assert.equal(r.allSubmitted, true);

  await store.close();
});

// ── Approve endpoint: atomic double-tap protection ───────────────────────────

test('approvePost: second concurrent call returns null (409)', async () => {
  const store = await makeStore();
  const post = await store.createPost({
    brand: 'propzombie', brief: 'x', copy: 'y',
    state: STATES.AWAITING_REVIEW, channel_ids: ['fb_1'],
  });

  // Simulate two concurrent approve calls.
  const [r1, r2] = await Promise.all([
    store.approvePost(post.id),
    store.approvePost(post.id),
  ]);

  const results = [r1, r2];
  const successes = results.filter(Boolean);
  const failures = results.filter((r) => !r);

  assert.equal(successes.length, 1, 'exactly one approvePost must succeed');
  assert.equal(failures.length, 1, 'exactly one approvePost must return null (concurrent tap)');
  assert.equal(successes[0].state, STATES.QUEUED, 'the winner must set state to queued');

  await store.close();
});

test('POST /api/posts/:id/approve: double-tap yields one 200 and one 409', async () => {
  // Build deps manually so the test uses an isolated in-memory store,
  // not the real production SQLite path that buildDeps() would open.
  const store = await makeStore();
  const drafter = { draft: async (x) => x.brief };
  const publisher = { publish: async () => { throw new Error('no publisher in this test'); } };
  const deps = { store, drafter, publisher };
  const app = createApp(deps);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const base = `http://localhost:${port}`;

  // Log in.
  const loginRes = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=testpass',
    redirect: 'manual',
  });
  const cookie = loginRes.headers.get('set-cookie');

  // Create a post in awaiting_review.
  const post = await store.createPost({
    brand: 'propzombie', brief: 'tap test', copy: 'double tap',
    state: STATES.AWAITING_REVIEW, channel_ids: [],
  });

  // Fire two approvals concurrently.
  const [res1, res2] = await Promise.all([
    fetch(`${base}/api/posts/${post.id}/approve`, { method: 'POST', headers: { cookie } }),
    fetch(`${base}/api/posts/${post.id}/approve`, { method: 'POST', headers: { cookie } }),
  ]);

  const statuses = [res1.status, res2.status].sort();
  assert.deepEqual(statuses, [200, 409], 'exactly one 200 and one 409 on concurrent approvals');

  // Post must be in queued state.
  const after = await store.getPost(post.id);
  assert.ok(after.state === STATES.QUEUED || after.state === STATES.FAILED,
    `post must be queued or failed after approval (is ${after.state})`);

  server.close();
  await store.close();
});

// ── claimPost: crash-recovery clears stale buffer_submits ────────────────────

test('claimPost clears null buffer_submits, allowing crash-recovery retry to reinsert', async () => {
  const store = await makeStore();
  const post = await store.createPost({
    brand: 'propzombie', brief: 'crash', copy: 'retry me',
    state: STATES.QUEUED, channel_ids: ['ch_1'],
  });

  // Simulate a crash: the dedup row was inserted but no buffer_post_id was recorded.
  await store.insertBufferSubmit(post.id, 'ch_1');
  // Confirm the row exists with null buffer_post_id.
  const stale = await store.getBufferSubmit(post.id, 'ch_1');
  assert.ok(stale, 'stale dedup row must exist before claim');
  assert.equal(stale.buffer_post_id, null, 'buffer_post_id must be null (simulated crash)');

  // claimPost must clear the stale row.
  const claimed = await store.claimPost(post.id);
  assert.ok(claimed, 'claimPost must succeed for a QUEUED post');
  assert.equal(claimed.state, STATES.POSTING);
  assert.equal(claimed.attempts, 1);

  const afterClaim = await store.getBufferSubmit(post.id, 'ch_1');
  assert.equal(afterClaim, null, 'stale dedup row must be cleared by claimPost');

  // Retry can now insert a fresh dedup slot.
  const reinserted = await store.insertBufferSubmit(post.id, 'ch_1');
  assert.equal(reinserted, true, 'fresh insert must succeed after stale row was cleared');

  await store.close();
});
