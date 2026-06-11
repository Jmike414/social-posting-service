'use strict';

const { STATES } = require('./state');
const { logger } = require('./logger');

// The worker: the single place that advances the state machine. It picks up
// `drafted` rows (runs the drafter, routes to review or queue or the human
// queue), and `queued`/`posting` rows (runs the poster, then published/failed).
//
// Pure-ish and dependency-injected so tests drive it directly with a fake
// publisher/drafter and an in-memory store.

function serializeError(err) {
  const base = { message: err && err.message };
  if (err && err.code) base.code = err.code;
  if (err && err.status) base.status = err.status;
  if (err && err.graphqlErrors) base.graphqlErrors = err.graphqlErrors; // verbatim beta-API payload
  if (err && err.raw !== undefined) base.raw = err.raw;
  try {
    return JSON.stringify(base);
  } catch {
    return String(err && err.message);
  }
}

function platformForDestination(destination) {
  if (destination === 'manual_whatsapp') return 'whatsapp';
  if (destination === 'manual_fb_group') return 'fb_group';
  return 'fb_group';
}

async function processDrafted(post, { store, drafter }) {
  const copy = await drafter.draft({
    brand: post.brand,
    brief: post.brief,
    intendedPostTime: post.intended_post_time,
    hasImage: !!post.image_path,
  });

  // Manual destinations (FB Groups / WhatsApp) never touch Buffer — draft, then
  // drop straight into the human-post queue as a manual-post card.
  if (post.destination === 'manual_fb_group' || post.destination === 'manual_whatsapp') {
    await store.updatePost(post.id, { copy, state: STATES.MANUAL });
    await store.addHumanPost({
      source_post_id: post.id,
      brand: post.brand,
      platform: platformForDestination(post.destination),
      copy,
      image_path: post.image_path,
    });
    logger.info(`Post ${post.id} drafted -> human_post_queue (${post.destination})`);
    return;
  }

  // Buffer destination: resolve the brand's channels now so the Review view can
  // show the targets, then route on the auto_publish flag.
  const channels = await store.resolveChannelsForBrand(post.brand);
  const channelIds = channels.map((c) => c.id);
  const nextState = post.auto_publish ? STATES.QUEUED : STATES.AWAITING_REVIEW;
  await store.updatePost(post.id, { copy, channel_ids: channelIds, state: nextState });
  logger.info(`Post ${post.id} drafted -> ${nextState}${post.auto_publish ? ' (auto_publish)' : ''}`);
}

async function processQueued(post, { store, publisher }) {
  const attempts = (post.attempts || 0) + 1;
  const working = await store.updatePost(post.id, { state: STATES.POSTING, attempts });
  try {
    const result = await publisher.publish(working);
    if (result.allSubmitted) {
      await store.updatePost(post.id, { state: STATES.PUBLISHED, buffer_post_ids: result.bufferPostIds, error: null });
      logger.info(`Post ${post.id} published. Buffer ids: ${JSON.stringify(result.bufferPostIds)}`);
    } else {
      // Should not happen (publish throws on per-channel failure) — be explicit.
      throw Object.assign(new Error('Not all channels submitted'), { code: 'PARTIAL' });
    }
  } catch (err) {
    const errStr = serializeError(err);
    logger.error(`Post ${post.id} failed after retries: ${errStr}`);
    await store.updatePost(post.id, { state: STATES.FAILED, error: errStr });
    await store.addHumanPost({
      source_post_id: post.id,
      brand: post.brand,
      platform: 'failed_buffer',
      copy: post.copy,
      image_path: post.image_path,
      error: errStr,
    });
  }
}

// Process one bounded batch. Returns counts. Safe to call repeatedly.
async function processOnce(deps, { batch = 10 } = {}) {
  const { store } = deps;
  let drafted = 0;
  let posted = 0;

  for (const post of await store.listPosts({ state: STATES.DRAFTED, limit: batch })) {
    await processDrafted(post, deps);
    drafted++;
  }
  // `posting` rows are resumed (crash recovery) — publisher idempotency adopts
  // any already-created posts instead of double-submitting.
  for (const post of await store.listPosts({ states: [STATES.QUEUED, STATES.POSTING], limit: batch })) {
    await processQueued(post, deps);
    posted++;
  }
  return { drafted, posted };
}

// Background loop. Non-overlapping ticks. Returns a stop() function.
function startWorker(deps, { intervalMs = 1500 } = {}) {
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await processOnce(deps);
    } catch (e) {
      logger.error(`Worker tick error: ${e.message}`);
    } finally {
      running = false;
    }
  };
  const handle = setInterval(tick, intervalMs);
  if (handle.unref) handle.unref();
  return function stop() {
    stopped = true;
    clearInterval(handle);
  };
}

module.exports = { processOnce, processDrafted, processQueued, startWorker, serializeError };
