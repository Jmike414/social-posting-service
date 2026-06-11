'use strict';

// The social_posts state machine.
//
//   drafted ──► awaiting_review ──► queued ──► posting ──► published
//      │              │                            │
//      │ (auto_publish=true bypasses review)       └──► failed ──► (human_post_queue)
//      └──────────────┘                  queued can also ──► failed
//
//   awaiting_review ──► rejected   (terminal; never reaches Buffer)
//   Editing copy in review keeps the row in awaiting_review (no transition).
//
// Manual destinations (FB Groups / WhatsApp) never enter `queued`; after drafting
// they are written straight into human_post_queue and the row is marked `manual`.

const STATES = Object.freeze({
  DRAFTED: 'drafted',
  AWAITING_REVIEW: 'awaiting_review',
  QUEUED: 'queued',
  POSTING: 'posting',
  PUBLISHED: 'published',
  REJECTED: 'rejected',
  FAILED: 'failed',
  MANUAL: 'manual', // routed to human_post_queue (FB group / WhatsApp), not a Buffer post
});

const TRANSITIONS = Object.freeze({
  drafted: ['awaiting_review', 'queued', 'manual'],
  awaiting_review: ['queued', 'rejected'],
  queued: ['posting', 'failed'],
  posting: ['published', 'failed', 'queued'], // back to queued on transient retry exhaustion-recovery
  published: [],
  rejected: [],
  failed: [],
  manual: [],
});

const TERMINAL = Object.freeze(['published', 'rejected', 'failed', 'manual']);

function canTransition(from, to) {
  const allowed = TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal state transition: ${from} -> ${to}`);
  }
}

function isTerminal(state) {
  return TERMINAL.includes(state);
}

module.exports = { STATES, TRANSITIONS, TERMINAL, canTransition, assertTransition, isTerminal };
