'use strict';

// The publisher seam. Buffer is the only implementation today, but the beta API
// means we want a clean swap point: if Buffer changes drastically (or we move to
// another scheduler, or revive a direct Graph poster), only a new class behind
// this interface changes — callers (the worker) stay put.
//
// Contract:
//   publish(post)            -> { bufferPostIds, allSubmitted }   adds to the Buffer queue
//                                (or honors post.intended_post_time as a scheduled time)
//   schedule(post, dueAtIso) -> { bufferPostIds, allSubmitted }   explicit-timestamp schedule
//   getStatus(bufferPostId)  -> { id, status, ... } | null        live status from the provider

class SocialPublisher {
  // eslint-disable-next-line no-unused-vars
  async publish(post) {
    throw new Error('SocialPublisher.publish not implemented');
  }

  // eslint-disable-next-line no-unused-vars
  async schedule(post, dueAtIso) {
    throw new Error('SocialPublisher.schedule not implemented');
  }

  // eslint-disable-next-line no-unused-vars
  async getStatus(bufferPostId) {
    throw new Error('SocialPublisher.getStatus not implemented');
  }
}

module.exports = { SocialPublisher };
