'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeDueAt, generateAndScheduleBatch, submitToBuffer } = require('../src/scheduler/scheduler');
const { buildCreatePostInput, buildImageAsset, buildPostMetadata } = require('../src/publisher/buffer-client');
const { makeStore } = require('./helpers');

// Deterministic stub drafter so idempotency keys are stable across runs.
const drafter = { draft: async ({ brief }) => `POST: ${brief}` };

function fakeClient(createPost) {
  return { buildCreatePostInput, buildImageAsset, buildPostMetadata, createPost };
}

async function propzombieStore() {
  const store = await makeStore();
  await store.setChannels('propzombie', [{ id: 'pz_fb', service: 'facebook', name: 'PZ' }]);
  await store.setChannels('crewmando', [{ id: 'cm_fb', service: 'facebook', name: 'CM' }]);
  return store;
}

// ── DST-correct dueAt ────────────────────────────────────────────────────────
test('computeDueAt: Central offset is correct across DST (CDT in March, CST in November)', () => {
  // facebook slot = 09:00 Central
  assert.equal(computeDueAt('2026-03-10', { dayOffset: 0, slot: 'facebook' }), '2026-03-10T09:00:00.000-05:00');
  assert.equal(computeDueAt('2026-11-10', { dayOffset: 0, slot: 'facebook' }), '2026-11-10T09:00:00.000-06:00');
});

test('computeDueAt: dayOffset rolls the date forward', () => {
  assert.equal(computeDueAt('2026-03-10', { dayOffset: 2, slot: 'linkedin' }), '2026-03-12T08:00:00.000-05:00');
});

test('computeDueAt: rejects an invalid startDate', () => {
  assert.throws(() => computeDueAt('not-a-date', { dayOffset: 0, slot: 'facebook' }), /Invalid startDate/);
});

// ── dryRun preview ───────────────────────────────────────────────────────────
test('dryRun returns the planned batch without calling Buffer or writing rows', async () => {
  const store = await propzombieStore();
  let createCalls = 0;
  const client = fakeClient(async () => { createCalls++; return { ok: true, post: { id: 'x' } }; });
  const summary = await generateAndScheduleBatch({
    startDate: '2026-06-15', brandFilter: 'propzombie', dryRun: true,
    deps: { store, drafter, client, sleep: async () => {}, baseDelayMs: 0 },
  });
  assert.equal(createCalls, 0, 'Buffer.createPost must not be called in dryRun');
  assert.equal((await store.listScheduledPosts()).length, 0, 'dryRun writes no rows');
  assert.equal(summary.planned, 3); // 2 facebook + 1 linkedin (propzombie calendar)
  assert.ok(summary.items.some((i) => i.status === 'planned'));
  assert.ok(summary.items.some((i) => i.status === 'skipped' && /linkedin/.test(i.reason)), 'linkedin has no channel -> skipped');
  await store.close();
});

// ── real run + idempotency ───────────────────────────────────────────────────
test('real run schedules to Buffer; re-running is idempotent (no duplicates)', async () => {
  const store = await propzombieStore();
  let n = 0;
  const client = fakeClient(async () => ({ ok: true, post: { id: 'bp_' + ++n } }));
  const deps = { store, drafter, client, sleep: async () => {}, baseDelayMs: 0 };

  const r1 = await generateAndScheduleBatch({ startDate: '2026-06-15', brandFilter: 'propzombie', dryRun: false, deps });
  assert.equal(r1.created, 2, '2 facebook entries scheduled');
  assert.equal(r1.skipped, 1, 'linkedin skipped (no channel)');
  assert.equal((await store.listScheduledPosts({ status: 'scheduled' })).length, 2);

  const r2 = await generateAndScheduleBatch({ startDate: '2026-06-15', brandFilter: 'propzombie', dryRun: false, deps });
  assert.equal(r2.created, 0, 're-run creates nothing new');
  assert.equal((await store.listScheduledPosts({ status: 'scheduled' })).length, 2, 'still 2 — no duplicates');
  await store.close();
});

test('scheduled posts are sent to Buffer as customScheduled with a dueAt', async () => {
  const store = await propzombieStore();
  const inputs = [];
  const client = fakeClient(async (input) => { inputs.push(input); return { ok: true, post: { id: 'bp_' + inputs.length } }; });
  await generateAndScheduleBatch({
    startDate: '2026-06-15', brandFilter: 'propzombie', dryRun: false,
    deps: { store, drafter, client, sleep: async () => {}, baseDelayMs: 0 },
  });
  assert.ok(inputs.length >= 1);
  for (const input of inputs) {
    assert.equal(input.mode, 'customScheduled');
    assert.ok(input.dueAt, 'carries a scheduled dueAt');
  }
  await store.close();
});

test('a Buffer rejection marks that row failed but the batch continues', async () => {
  const store = await propzombieStore();
  const client = fakeClient(async () => { const e = new Error('Buffer rejected post'); e.code = 'GRAPHQL_ERROR'; throw e; });
  const r = await generateAndScheduleBatch({
    startDate: '2026-06-15', brandFilter: 'propzombie', dryRun: false,
    deps: { store, drafter, client, sleep: async () => {}, baseDelayMs: 0 },
  });
  assert.equal(r.failed, 2, 'both facebook posts failed');
  assert.equal((await store.listScheduledPosts({ status: 'failed' })).length, 2);
  await store.close();
});

// ── rate-limit backoff (submitToBuffer) ──────────────────────────────────────
test('submitToBuffer retries on rate-limit then succeeds', async () => {
  let attempts = 0;
  const delays = [];
  const client = fakeClient(async () => {
    attempts++;
    if (attempts < 3) { const e = new Error('429'); e.code = 'RATE_LIMIT'; throw e; }
    return { ok: true, post: { id: 'ok' } };
  });
  const post = await submitToBuffer({
    client, channelId: 'c', service: 'facebook', text: 'hi', dueAt: '2026-06-15T09:00:00.000-05:00',
    sleep: async (ms) => delays.push(ms), maxAttempts: 3, baseDelayMs: 100,
  });
  assert.equal(post.id, 'ok');
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [100, 200]);
});

test('submitToBuffer gives up after maxAttempts on persistent rate-limit', async () => {
  let attempts = 0;
  const client = fakeClient(async () => { attempts++; const e = new Error('429'); e.code = 'RATE_LIMIT'; throw e; });
  await assert.rejects(() => submitToBuffer({
    client, channelId: 'c', service: 'facebook', text: 'hi', dueAt: '2026-06-15T09:00:00.000-05:00',
    sleep: async () => {}, maxAttempts: 3, baseDelayMs: 1,
  }), (e) => e.code === 'RATE_LIMIT');
  assert.equal(attempts, 3);
});
