'use strict';

const { SocialPublisher } = require('./SocialPublisher');
const bufferClient = require('./buffer-client');
const { config } = require('../config');
const { logger } = require('../logger');

const { BufferError } = bufferClient;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Decide the Buffer scheduling mode from the job. An explicit intended time means
// customScheduled (Buffer posts at exactly that time); otherwise addToQueue lets
// Buffer pick the next slot from the channel's schedule.
function modeForPost(post, dueAtOverride) {
  const dueAt = dueAtOverride || post.intended_post_time || null;
  if (dueAt) return { mode: 'customScheduled', dueAt: new Date(dueAt).toISOString() };
  return { mode: 'addToQueue', dueAt: null };
}

class BufferPublisher extends SocialPublisher {
  // Dependencies are injectable so tests can supply a fake Buffer client, a
  // synchronous sleep, and an in-memory store.
  constructor({ store, client = bufferClient, sleep = defaultSleep, maxAttempts = 3, baseDelayMs = 500 } = {}) {
    super();
    this.store = store;
    this.client = client;
    this.sleep = sleep;
    this.maxAttempts = maxAttempts;
    this.baseDelayMs = baseDelayMs;
    this._orgIdCache = null;
  }

  async _orgId() {
    if (this._orgIdCache) return this._orgIdCache;
    if (config.buffer.organizationId) return (this._orgIdCache = config.buffer.organizationId);
    const fromKv = this.store && this.store.kvGet ? await this.store.kvGet('organization_id') : null;
    if (fromKv) return (this._orgIdCache = fromKv);
    this._orgIdCache = await this.client.resolveOrganizationId();
    return this._orgIdCache;
  }

  // Public, Buffer-reachable URL for an uploaded image. Buffer fetches images by
  // URL, so this must resolve to a host Buffer can reach (real https on deploy).
  _imageAssetsFor(post) {
    if (!post.image_path) return [];
    const raw = String(post.image_path);
    // Already an absolute URL (programmatic /enqueue) -> use as-is. Otherwise it's
    // a local upload path served by this service under PUBLIC_BASE_URL.
    const url = /^https?:\/\//i.test(raw) ? raw : `${config.publicBaseUrl}/${raw.replace(/^\/+/, '')}`;
    return [this.client.buildImageAsset({ url, altText: post.image_alt || undefined })];
  }

  // Retry wrapper: max `maxAttempts`, exponential backoff, but ONLY for transient
  // errors (5xx / rate-limit). Hard errors (validation, auth, 4xx) fail fast.
  async _withRetry(fn) {
    let lastErr;
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      try {
        return await fn(attempt);
      } catch (err) {
        lastErr = err;
        const retryable = err instanceof BufferError && err.retryable;
        if (!retryable || attempt === this.maxAttempts - 1) throw err;
        const backoff = err.retryAfter != null ? err.retryAfter * 1000 : this.baseDelayMs * 2 ** attempt;
        logger.warn(`Buffer transient error (${err.code}); retry ${attempt + 1}/${this.maxAttempts - 1} in ${backoff}ms`);
        await this.sleep(backoff);
      }
    }
    throw lastErr;
  }

  // Submit one channel. Idempotency: if this is a retry (or the job was already
  // attempted — e.g. recovered after a crash mid-submit), first look for an
  // already-created post with identical text on that channel and adopt it instead
  // of resubmitting. This is the "crash between submit and store" guard.
  async _submitChannel(post, channelId, service, mode, dueAt, jobPreviouslyAttempted) {
    return this._withRetry(async (attempt) => {
      const ambiguous = attempt > 0 || jobPreviouslyAttempted;
      if (ambiguous && post.copy) {
        try {
          const orgId = await this._orgId();
          const existing = await this.client.findPostByText({ organizationId: orgId, channelId, text: post.copy });
          if (existing) {
            logger.info(`Idempotency: adopted existing Buffer post ${existing.id} for channel ${channelId} (not resubmitting)`);
            return existing;
          }
        } catch (e) {
          // A failed recovery lookup must not block submission; log and continue.
          logger.warn(`Idempotency lookup failed (continuing to submit): ${e.message}`);
        }
      }
      const assets = this._imageAssetsFor(post);
      // Buffer requires the per-service post type (Facebook/Instagram reject posts
      // without one), so attach metadata derived from this channel's service.
      const metadata = this.client.buildPostMetadata ? this.client.buildPostMetadata(service) : null;
      const input = this.client.buildCreatePostInput({ channelId, text: post.copy, mode, dueAt, assets, metadata });
      const { post: created } = await this.client.createPost(input);
      return created;
    });
  }

  // Submit the job to every resolved channel. Already-stored channels are never
  // resubmitted. Each freshly-returned Buffer id is persisted immediately so a
  // crash mid-loop cannot lose (or duplicate) it.
  async _publishToChannels(post, mode, dueAt) {
    const channelIds = Array.isArray(post.channel_ids) ? post.channel_ids : [];
    if (!channelIds.length) {
      throw new BufferError('No channels resolved for this post (brand has no channel map)', { code: 'CLIENT_ERROR' });
    }
    const bufferPostIds = { ...(post.buffer_post_ids || {}) };
    const jobPreviouslyAttempted = (post.attempts || 0) > 0;

    // Map each channel id -> service so we can attach the per-service post type
    // metadata Buffer requires.
    let serviceById = {};
    if (this.store && this.store.resolveChannelsForBrand) {
      const chans = await this.store.resolveChannelsForBrand(post.brand);
      serviceById = Object.fromEntries(chans.map((c) => [c.id, c.service]));
    }

    for (const channelId of channelIds) {
      if (bufferPostIds[channelId]) continue; // stored id => never resubmit
      const node = await this._submitChannel(post, channelId, serviceById[channelId], mode, dueAt, jobPreviouslyAttempted);
      bufferPostIds[channelId] = node.id;
      if (this.store && this.store.updatePost) {
        await this.store.updatePost(post.id, { buffer_post_ids: bufferPostIds });
      }
    }
    const allSubmitted = channelIds.every((c) => bufferPostIds[c]);
    return { bufferPostIds, allSubmitted };
  }

  async publish(post) {
    const { mode, dueAt } = modeForPost(post);
    return this._publishToChannels(post, mode, dueAt);
  }

  async schedule(post, dueAtIso) {
    const { mode, dueAt } = modeForPost(post, dueAtIso);
    return this._publishToChannels(post, mode, dueAt);
  }

  async getStatus(bufferPostId) {
    return this.client.getPost(bufferPostId);
  }
}

module.exports = { BufferPublisher };
