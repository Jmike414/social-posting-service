'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeDueAt, generateAndScheduleBatch } = require('../src/scheduler/scheduler');
const { processOnce } = require('../src/worker');
const { STATES } = require('../src/state');
const { makeStore } = require('./helpers');

// Deterministic stub drafter so idempotency keys are stable across runs.
const drafter = { draft: async ({ brief }) => `POST: ${brief}` };

async function pzStore() {
  const store = await makeStore();
  await store.setChannels('propzombie', [{ id: 'pz_fb', service: 'facebook', name: 'PZ' }]);
  await store.setChannels('crewmando', [{ id: 'cm_fb', service: 'facebook', name: 'CM' }]);
  return store;
}

// ── DST-correct dueAt ────────────────────────────────────────────────────────
test('computeDueAt: Central offset is correct across DST (CDT in March, CST in November)', () => {
  assert.equal(computeDueAt('2026-03-10', { dayOffset: 0, slot: 'facebook' }), '2026-03-10T09:00:00.000-05:00');
  assert.equal(computeDueAt('2026-11-10', { dayOffset: 0, slot: 'facebook' }), '2026-11-10T09:00:00.000-06:00');
});

test('computeDueAt: dayOffset rolls forward; invalid startDate rejected', () => {
  assert.equal(computeDueAt('2026-03-10', { dayOffset: 2, slot: 'linkedin' }), '2026-03-12T08:00:00.000-05:00');
  assert.throws(() => computeDueAt('not-a-date', { dayOffset: 0, slot: 'facebook' }), /Invalid startDate/);
});

// ── dryRun preview ───────────────────────────────────────────────────────────
test('dryRun previews the batch without creating any posts', async () => {
  const store = await pzStore();
  const s = await generateAndScheduleBatch({ startDate: '2026-06-15', brandFilter: 'propzombie', dryRun: true, deps: { store, drafter } });
  assert.equal((await store.listPosts({ limit: 100 })).length, 0, 'dryRun writes no rows');
  assert.equal(s.planned, 3); // 2 facebook + 1 linkedin
  assert.ok(s.items.some((i) => i.status === 'planned'));
  assert.ok(s.items.some((i) => i.status === 'skipped' && /linkedin/.test(i.reason)), 'linkedin has no channel -> skipped');
  await store.close();
});

// ── real run fills the Review queue ──────────────────────────────────────────
test('real run creates awaiting_review posts with generated copy, scheduled time, and target channel', async () => {
  const store = await pzStore();
  const s = await generateAndScheduleBatch({ startDate: '2026-06-15', brandFilter: 'propzombie', dryRun: false, deps: { store, drafter } });
  assert.equal(s.created, 2, '2 facebook entries queued for review');
  assert.equal(s.skipped, 1, 'linkedin skipped (no channel)');

  const review = await store.listPosts({ state: STATES.AWAITING_REVIEW, limit: 100 });
  assert.equal(review.length, 2);
  for (const p of review) {
    assert.equal(p.state, 'awaiting_review');
    assert.ok(p.copy.startsWith('POST: '), 'copy was generated, not re-drafted later');
    assert.ok(p.intended_post_time, 'carries the scheduled slot time');
    assert.deepEqual(p.channel_ids, ['pz_fb'], 'targets the calendar entry\'s specific channel');
    assert.ok(p.calendar_key, 'has an idempotency key');
  }
  await store.close();
});

test('re-running the same batch does not duplicate review posts (idempotent)', async () => {
  const store = await pzStore();
  const deps = { store, drafter };
  await generateAndScheduleBatch({ startDate: '2026-06-15', brandFilter: 'propzombie', dryRun: false, deps });
  const r2 = await generateAndScheduleBatch({ startDate: '2026-06-15', brandFilter: 'propzombie', dryRun: false, deps });
  assert.equal(r2.created, 0, 're-run creates nothing new');
  assert.equal((await store.listPosts({ state: STATES.AWAITING_REVIEW, limit: 100 })).length, 2, 'still 2 — no duplicates');
  await store.close();
});

// ── approve -> publish through the existing worker pipeline ───────────────────
test('a generated post, once approved, publishes via the worker at its scheduled time', async () => {
  const store = await pzStore();
  await generateAndScheduleBatch({ startDate: '2026-06-15', brandFilter: 'propzombie', dryRun: false, deps: { store, drafter } });
  const [p] = await store.listPosts({ state: STATES.AWAITING_REVIEW, limit: 1 });

  // Approve = move awaiting_review -> queued (what the console Approve button does).
  await store.updatePost(p.id, { state: STATES.QUEUED });

  const captured = [];
  const publisher = { publish: async (post) => { captured.push(post); return { allSubmitted: true, bufferPostIds: { pz_fb: 'bp1' } }; } };
  await processOnce({ store, drafter, publisher });

  const after = await store.getPost(p.id);
  assert.equal(after.state, STATES.PUBLISHED);
  assert.equal(captured[0].intended_post_time, p.intended_post_time, 'published with its scheduled time (worker -> customScheduled)');
  await store.close();
});
