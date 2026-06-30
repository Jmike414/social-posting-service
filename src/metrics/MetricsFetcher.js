'use strict';

const { logger } = require('../logger');
const { nowIso } = require('../store/mappers');

// Fetches the sent-post history from Buffer and upserts metrics into post_metrics.
//
// Join key: buffer_post_ids[channelId] (stored at createPost time) matches
// node.id in posts(filter:{status:[sent]}). The ID is assigned at scheduling
// time and persists unchanged through the send. post(id) returns NOT_FOUND for
// sent posts — that's a query-endpoint restriction, not an ID change.
//
// A post with no match in the sent list gets no metrics row (not in Buffer's
// sent history yet, or never actually sent). A missing metric is acceptable;
// a wrong one is not — no text-matching fallback.
async function fetchAndStoreMetrics({ store, client }) {
  const orgId = await client.resolveOrganizationId();
  const sentPosts = await client.getSentPostsWithMetrics(orgId);

  // Index sent posts by their Buffer ID for O(1) join.
  const byBufferId = new Map();
  for (const node of sentPosts) {
    if (node && node.id) byBufferId.set(node.id, node);
  }

  const localPosts = await store.listPosts({ limit: 500 });
  const published = localPosts.filter(
    (p) => p.state === 'published' && p.buffer_post_ids && typeof p.buffer_post_ids === 'object'
  );

  let updated = 0;
  const fetchedAt = nowIso();
  for (const post of published) {
    for (const [channelId, bufferPostId] of Object.entries(post.buffer_post_ids)) {
      const node = byBufferId.get(bufferPostId);
      if (!node) continue;
      await store.upsertPostMetrics({
        postId: post.id,
        channelId,
        bufferPostId,
        fetchedAt,
        metricsUpdatedAt: node.metricsUpdatedAt || null,
        metricsJson: JSON.stringify(node.metrics || []),
      });
      updated++;
    }
  }

  logger.info(`MetricsFetcher: ${sentPosts.length} sent posts from Buffer → ${updated} metrics rows updated`);
  return { sentCount: sentPosts.length, updated };
}

module.exports = { fetchAndStoreMetrics };
