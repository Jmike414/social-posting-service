'use strict';

const { SocialPublisher } = require('./SocialPublisher');
const bufferClient = require('./buffer-client');
const { config } = require('../config');
const { logger } = require('../logger');

const { BufferError } = bufferClient;

// Map eligible_destinations channel-type strings to Buffer service names.
// Used to decide whether a channel should receive a video post.
const CHANNEL_TYPE_TO_SERVICE = {
  ig_reel: 'instagram', ig_story: 'instagram', ig_feed: 'instagram',
  fb_reel: 'facebook',  fb_story: 'facebook',  fb_feed: 'facebook',
  linkedin: 'linkedin',
};

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Decide the Buffer scheduling mode from the job. An explicit intended time means
// customScheduled (Buffer publishes at exactly that time); otherwise shareNow so an
// approval publishes immediately ("one-click posting"). A post can opt into Buffer's
// auto-spaced queue by setting scheduling_mode = 'addToQueue'.
function modeForPost(post, dueAtOverride) {
  const dueAt = dueAtOverride || post.intended_post_time || null;
  if (dueAt) return { mode: 'customScheduled', dueAt: new Date(dueAt).toISOString() };
  if (post.scheduling_mode === 'addToQueue') return { mode: 'addToQueue', dueAt: null };
  return { mode: 'shareNow', dueAt: null };
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

  // Public, Buffer-reachable URL for an uploaded image or video. Buffer fetches
  // media by URL so this must resolve to a publicly reachable host on deploy.
  _mediaAssetsFor(post) {
    if (!post.image_path) return [];
    const raw = String(post.image_path);
    const url = /^https?:\/\//i.test(raw) ? raw : `${config.publicBaseUrl}/${raw.replace(/^\/+/, '')}`;
    if (post.media_type === 'video') {
      return [this.client.buildVideoAsset({ url })];
    }
    return [this.client.buildImageAsset({ url, altText: post.image_alt || undefined })];
  }

  // Returns true when the video ratio is eligible for this Buffer channel service.
  // Always returns true for non-video posts (no ratio constraint applies).
  _videoEligibleForService(post, service) {
    if (post.media_type !== 'video') return true;
    const eligible = Array.isArray(post.eligible_destinations) ? post.eligible_destinations : [];
    if (!eligible.length) return true; // ratio unknown — allow and let Buffer validate
    const eligibleServices = new Set(eligible.map((d) => CHANNEL_TYPE_TO_SERVICE[d]).filter(Boolean));
    return eligibleServices.has(String(service || '').toLowerCase());
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
      const assets = this._mediaAssetsFor(post);
      const isReel = post.media_type === 'video' && post.detected_ratio === '9:16';
      const metadata = this.client.buildPostMetadata ? this.client.buildPostMetadata(service, { isReel }) : null;
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

    // Instagram requires media and only accepts video in the 9:16 (Reel) format.
    // Skip IG for text-only posts, and skip any service channel whose format the
    // video's detected ratio doesn't match (delegator: route, never convert).
    const hasMedia = !!post.image_path;
    const targetChannels = channelIds.filter((id) => {
      const svc = serviceById[id];
      if (svc === 'instagram' && !hasMedia) {
        logger.info(`Skipping Instagram channel ${id} — text-only post (Instagram requires media).`);
        return false;
      }
      if (!this._videoEligibleForService(post, svc)) {
        const ratio = post.detected_ratio || 'unknown';
        logger.info(`Skipping ${svc} channel ${id} — video ratio ${ratio} is not eligible for this service.`);
        return false;
      }
      return true;
    });
    if (!targetChannels.length) {
      throw new BufferError(
        'No publishable channels for this post (e.g. text-only with only Instagram connected). Add an image, or connect a Facebook page.',
        { code: 'CLIENT_ERROR' }
      );
    }

    for (const channelId of targetChannels) {
      if (bufferPostIds[channelId]) continue; // stored id => never resubmit

      // Layer 2: claim the dedup slot before any network call. If the INSERT
      // conflicts, another caller already holds this slot — either in-flight
      // (skip to prevent duplicate) or already completed (adopt the stored id).
      // Crash recovery: claimPost clears null slots on re-claim, so retry always
      // gets a clean insert here.
      if (this.store && this.store.insertBufferSubmit) {
        const slotClaimed = await this.store.insertBufferSubmit(post.id, channelId);
        if (!slotClaimed) {
          const existing = await this.store.getBufferSubmit(post.id, channelId);
          if (existing && existing.buffer_post_id) {
            bufferPostIds[channelId] = existing.buffer_post_id;
            if (this.store.updatePost) await this.store.updatePost(post.id, { buffer_post_ids: bufferPostIds });
            logger.info(`Dedup: adopted ${existing.buffer_post_id} for channel ${channelId} (post_id=${post.id})`);
          } else {
            logger.warn(`Dedup: slot conflict with no buffer_post_id for ${post.id}/${channelId} — skipping to prevent duplicate`);
          }
          continue;
        }
      }

      const node = await this._submitChannel(post, channelId, serviceById[channelId], mode, dueAt, jobPreviouslyAttempted);
      bufferPostIds[channelId] = node.id;
      if (this.store && this.store.updatePost) {
        await this.store.updatePost(post.id, { buffer_post_ids: bufferPostIds });
      }
      if (this.store && this.store.recordBufferSubmit) {
        await this.store.recordBufferSubmit(post.id, channelId, node.id);
      }
    }
    const allSubmitted = targetChannels.every((c) => bufferPostIds[c]);
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
