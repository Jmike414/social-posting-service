'use strict';

const crypto = require('crypto');
const { DateTime } = require('luxon');
const { CALENDAR, SLOTS, TIMEZONE } = require('./content-calendar');
const { createDrafter } = require('../drafter');
const { logger } = require('../logger');
const { STATES } = require('../state');

// Stable idempotency key for a calendar slot+copy. Re-running a batch with the
// same start date + unchanged calendar produces the same keys, so already-queued
// posts are skipped instead of duplicated.
function calendarKey(brand, channel, dueAt, text) {
  const h = crypto.createHash('sha1').update(String(text || '')).digest('hex').slice(0, 12);
  return `${brand}|${channel}|${dueAt}|${h}`;
}

// Compute the post's dueAt as an ISO 8601 string with the CORRECT Central-time
// UTC offset for that date (DST-aware via luxon: CDT -05:00 vs CST -06:00).
function computeDueAt(startDate, entry) {
  const time = SLOTS[entry.slot] || SLOTS[entry.channel] || '09:00';
  const [hh, mm] = String(time).split(':').map((n) => parseInt(n, 10));
  const base = DateTime.fromISO(startDate, { zone: TIMEZONE });
  if (!base.isValid) throw new Error(`Invalid startDate "${startDate}" (expected YYYY-MM-DD)`);
  return base.plus({ days: entry.dayOffset || 0 }).set({ hour: hh, minute: mm, second: 0, millisecond: 0 }).toISO();
}

// Generate a batch from the content calendar INTO the console's Review queue.
// Each calendar entry becomes a `social_posts` row in `awaiting_review` — copy
// generated, scheduled time (`intended_post_time`) and target channel attached.
// The owner approves it with one click in the console; on approval the worker
// schedules it to Buffer (customScheduled) for its dueAt. Rejected posts never
// reach Buffer. (We control approval here because Buffer's own approval gate is a
// paid-plan feature.)
//   { startDate:'YYYY-MM-DD', brandFilter:'propzombie'|'crewmando'|'both', dryRun, deps }
//   deps: { store, drafter?, allowImages? }
// Returns a summary { planned, created, skipped, failed, items[] }.
async function generateAndScheduleBatch({ startDate, brandFilter, dryRun = false, deps = {} }) {
  const { store } = deps;
  if (!store) throw new Error('generateAndScheduleBatch requires deps.store');
  if (!startDate) throw new Error('startDate (YYYY-MM-DD) is required');
  const drafter = deps.drafter || createDrafter();
  const allowImages = !!deps.allowImages; // images need durable public hosting (off by default)

  const wantBrand = (b) => !brandFilter || brandFilter === 'both' || b === brandFilter;
  const entries = CALENDAR.filter((e) => wantBrand(e.brand));

  // Resolve each brand's registered channels once.
  const channelsByBrand = {};
  for (const brand of [...new Set(entries.map((e) => e.brand))]) {
    channelsByBrand[brand] = await store.resolveChannelsForBrand(brand);
  }

  const summary = { startDate, dryRun, planned: 0, created: 0, skipped: 0, failed: 0, items: [] };

  for (const entry of entries) {
    const dueAt = computeDueAt(startDate, entry);
    const chans = channelsByBrand[entry.brand] || [];
    const channel = chans.find((c) => String(c.service).toLowerCase() === String(entry.channel).toLowerCase());

    // Generate copy from the brief (fall back to the brief text on drafter error).
    let text;
    try {
      text = await drafter.draft({ brand: entry.brand, brief: entry.brief, hasImage: false });
    } catch (e) {
      logger.warn(`Scheduler: drafter failed for ${entry.brand}/${entry.channel}, using brief verbatim: ${e.message}`);
      text = entry.brief;
    }

    // Image hosting isn't durable-public yet -> text-only this batch (see README).
    const imageUrl = allowImages ? (entry.imageUrl || null) : null;

    const item = { brand: entry.brand, channel: entry.channel, metro: entry.metro, dueAt, text, status: null, reason: null, postId: null };
    summary.planned++;

    if (!channel) {
      item.status = 'skipped';
      item.reason = `no '${entry.channel}' channel registered for ${entry.brand}`;
      summary.skipped++;
      summary.items.push(item);
      continue;
    }

    const key = calendarKey(entry.brand, entry.channel, dueAt, text);

    if (dryRun) {
      item.status = 'planned';
      summary.items.push(item);
      continue;
    }

    // Idempotency: skip if an active post already exists for this calendar key.
    const existing = await store.findActivePostByCalendarKey(key);
    if (existing) {
      item.status = 'skipped';
      item.reason = 'already in the review queue (idempotent)';
      item.postId = existing.id;
      summary.skipped++;
      summary.items.push(item);
      continue;
    }

    try {
      const post = await store.createPost({
        brand: entry.brand,
        destination: 'buffer',
        brief: entry.brief,
        copy: text, // already generated — no re-draft in the worker
        image_path: imageUrl,
        intended_post_time: dueAt, // worker schedules to Buffer for this time on approval
        channel_ids: [channel.id], // this calendar entry's specific channel
        state: STATES.AWAITING_REVIEW,
        auto_publish: false,
        ai_draft: false,
        calendar_key: key,
      });
      item.status = 'awaiting_review';
      item.postId = post.id;
      summary.created++;
      logger.info(`Scheduler: queued for review ${entry.brand}/${entry.channel} @ ${dueAt} (post ${post.id})`);
    } catch (e) {
      item.status = 'failed';
      item.reason = e.message;
      summary.failed++;
      logger.error(`Scheduler: failed to queue ${entry.brand}/${entry.channel}: ${e.message}`);
    }

    summary.items.push(item);
  }

  return summary;
}

module.exports = { generateAndScheduleBatch, computeDueAt, calendarKey };
