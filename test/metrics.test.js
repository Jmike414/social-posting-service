'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchAndStoreMetrics } = require('../src/metrics/MetricsFetcher');
const { makeStore } = require('./helpers');

function stubClient(sentPosts = []) {
  return {
    resolveOrganizationId: async () => 'org_test',
    getSentPostsWithMetrics: async () => sentPosts,
  };
}

async function seedPublishedPost(store, { postId, bufferPostId, channelId = 'ch1' } = {}) {
  const { enqueue } = require('../src/enqueue');
  const post = await enqueue(store, { brand: 'propzombie', brief: 'test', destination: 'buffer' });
  // Manually drive to published state with buffer_post_ids
  await store.updatePost(post.id, {
    state: 'published',
    buffer_post_ids: { [channelId]: bufferPostId },
    channel_ids: [channelId],
  });
  const refreshed = await store.getPost(post.id);
  return refreshed;
}

// ── upsertPostMetrics round-trip ─────────────────────────────────────────────
test('upsertPostMetrics stores and retrieves a metrics row', async () => {
  const store = await makeStore();
  await store.upsertPostMetrics({
    postId: 'p1',
    channelId: 'ch1',
    bufferPostId: 'buf1',
    fetchedAt: '2026-06-29T00:00:00.000Z',
    metricsUpdatedAt: '2026-06-29T00:01:00.000Z',
    metricsJson: JSON.stringify([{ type: 'impressions', name: 'Impressions', value: 42, unit: 'count' }]),
  });
  const rows = await store.getPostMetrics('p1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].buffer_post_id, 'buf1');
  const parsed = JSON.parse(rows[0].metrics_json);
  assert.equal(parsed[0].value, 42);
  await store.close();
});

// ── upsert idempotency ───────────────────────────────────────────────────────
test('upsertPostMetrics overwrites on re-upsert (same post_id + channel_id)', async () => {
  const store = await makeStore();
  const base = {
    postId: 'p1', channelId: 'ch1', bufferPostId: 'buf1',
    fetchedAt: '2026-06-29T00:00:00.000Z', metricsUpdatedAt: null,
    metricsJson: JSON.stringify([{ type: 'impressions', name: 'Impressions', value: 5, unit: 'count' }]),
  };
  await store.upsertPostMetrics(base);
  await store.upsertPostMetrics({ ...base, metricsJson: JSON.stringify([{ type: 'impressions', name: 'Impressions', value: 99, unit: 'count' }]) });
  const rows = await store.getPostMetrics('p1');
  assert.equal(rows.length, 1, 'no duplicate row created');
  assert.equal(JSON.parse(rows[0].metrics_json)[0].value, 99, 'value updated to latest');
  await store.close();
});

// ── fetchAndStoreMetrics joins by buffer_post_id ─────────────────────────────
test('fetchAndStoreMetrics writes a metrics row for each matching published post', async () => {
  const store = await makeStore();
  await store.setChannels('propzombie', [{ id: 'ch1', service: 'facebook', name: 'PZ FB' }]);
  const post = await seedPublishedPost(store, { bufferPostId: 'buf_abc', channelId: 'ch1' });

  const client = stubClient([{
    id: 'buf_abc',
    channelId: 'ch1',
    sentAt: '2026-06-29T12:00:00.000Z',
    metricsUpdatedAt: '2026-06-29T12:01:00.000Z',
    metrics: [
      { type: 'impressions', name: 'Impressions', value: 100, unit: 'count' },
      { type: 'likes', name: 'Likes', value: 3, unit: 'count' },
    ],
  }]);

  const result = await fetchAndStoreMetrics({ store, client });
  assert.equal(result.updated, 1);

  const rows = await store.getPostMetrics(post.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].buffer_post_id, 'buf_abc');
  const parsed = JSON.parse(rows[0].metrics_json);
  assert.equal(parsed.find((m) => m.type === 'impressions').value, 100);
  await store.close();
});

// ── no-match silently skipped ────────────────────────────────────────────────
test('fetchAndStoreMetrics silently skips local posts with no matching Buffer entry', async () => {
  const store = await makeStore();
  await store.setChannels('propzombie', [{ id: 'ch1', service: 'facebook', name: 'PZ FB' }]);
  const post = await seedPublishedPost(store, { bufferPostId: 'buf_xyz', channelId: 'ch1' });

  // Buffer returns a different post ID — no join
  const client = stubClient([{
    id: 'buf_DIFFERENT',
    channelId: 'ch1',
    sentAt: '2026-06-29T12:00:00.000Z',
    metricsUpdatedAt: null,
    metrics: [],
  }]);

  const result = await fetchAndStoreMetrics({ store, client });
  assert.equal(result.updated, 0);

  const rows = await store.getPostMetrics(post.id);
  assert.equal(rows.length, 0, 'no metrics row written for unmatched post');
  await store.close();
});

// ── listAllPostMetrics ───────────────────────────────────────────────────────
test('listAllPostMetrics returns all rows ordered by post_id and channel_id', async () => {
  const store = await makeStore();
  await store.upsertPostMetrics({ postId: 'pB', channelId: 'ch1', bufferPostId: 'b1', fetchedAt: 'now', metricsUpdatedAt: null, metricsJson: '[]' });
  await store.upsertPostMetrics({ postId: 'pA', channelId: 'ch2', bufferPostId: 'b2', fetchedAt: 'now', metricsUpdatedAt: null, metricsJson: '[]' });
  await store.upsertPostMetrics({ postId: 'pA', channelId: 'ch1', bufferPostId: 'b3', fetchedAt: 'now', metricsUpdatedAt: null, metricsJson: '[]' });
  const all = await store.listAllPostMetrics();
  assert.equal(all.length, 3);
  assert.equal(all[0].post_id, 'pA');
  assert.equal(all[0].channel_id, 'ch1');
  assert.equal(all[1].channel_id, 'ch2');
  assert.equal(all[2].post_id, 'pB');
  await store.close();
});
