'use strict';

const crypto = require('crypto');
const { DateTime } = require('luxon');
const { CALENDAR, SLOTS, TIMEZONE } = require('./content-calendar');
const { createDrafter } = require('../drafter');
const bufferClient = require('../publisher/buffer-client');
const { logger } = require('../logger');

// Stable idempotency key for a calendar slot+copy. Re-running a batch with the
// same start date + unchanged calendar produces the same keys, so already-sent
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

// Submit one scheduled post to Buffer with exponential backoff on transient
// (5xx / rate-limit) errors. mode=customScheduled + dueAt schedules it; with the
// channel on "Requires Approval" Buffer holds it as a pending-approval draft.
async function submitToBuffer({ client, channelId, service, text, dueAt, imageUrl, sleep, maxAttempts, baseDelayMs }) {
  const assets = imageUrl ? [client.buildImageAsset({ url: imageUrl })] : [];
  const metadata = client.buildPostMetadata ? client.buildPostMetadata(service) : null;
  const input = client.buildCreatePostInput({ channelId, text, mode: 'customScheduled', dueAt, assets, metadata });
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const { post } = await client.createPost(input);
      return post;
    } catch (e) {
      lastErr = e;
      const retryable = e && (e.code === 'RATE_LIMIT' || e.code === 'SERVER_ERROR');
      if (!retryable || attempt === maxAttempts - 1) throw e;
      const delay = e.retryAfter != null ? e.retryAfter * 1000 : baseDelayMs * 2 ** attempt;
      logger.warn(`Scheduler: transient Buffer error (${e.code}); retry ${attempt + 1}/${maxAttempts - 1} in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

// Generate + schedule a batch from the content calendar.
//   { startDate:'YYYY-MM-DD', brandFilter:'propzombie'|'crewmando'|'both', dryRun, deps }
//   deps: { store, drafter?, client?, sleep?, maxAttempts?, baseDelayMs?, allowImages? }
// Returns a summary { planned, created, skipped, failed, items[] }.
async function generateAndScheduleBatch({ startDate, brandFilter, dryRun = false, deps = {} }) {
  const { store } = deps;
  if (!store) throw new Error('generateAndScheduleBatch requires deps.store');
  if (!startDate) throw new Error('startDate (YYYY-MM-DD) is required');
  const drafter = deps.drafter || createDrafter();
  const client = deps.client || bufferClient;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const maxAttempts = deps.maxAttempts || 3;
  const baseDelayMs = deps.baseDelayMs == null ? 1500 : deps.baseDelayMs;
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
    const imageSkippedNote = !allowImages && entry.imageUrl ? ' (image dropped: durable public hosting not configured)' : '';

    const item = { brand: entry.brand, channel: entry.channel, metro: entry.metro, dueAt, text, status: null, reason: null, bufferPostId: null };
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
      item.reason = imageSkippedNote.trim() || null;
      summary.items.push(item);
      continue;
    }

    // Idempotency: skip if an active (awaiting_approval/sent) row already exists.
    const existing = await store.findActiveScheduledByKey(key);
    if (existing) {
      item.status = 'skipped';
      item.reason = 'already scheduled (idempotent)';
      item.bufferPostId = existing.buffer_post_id || null;
      summary.skipped++;
      summary.items.push(item);
      continue;
    }

    const row = await store.createScheduledPost({
      brand: entry.brand, channel: entry.channel, metro: entry.metro,
      due_at: dueAt, text, image_url: imageUrl, status: 'scheduled', calendar_key: key,
    });

    try {
      const post = await submitToBuffer({ client, channelId: channel.id, service: channel.service, text, dueAt, imageUrl, sleep, maxAttempts, baseDelayMs });
      await store.updateScheduledPost(row.id, { status: 'awaiting_approval', buffer_post_id: post.id, error: null });
      item.status = 'awaiting_approval';
      item.bufferPostId = post.id;
      item.reason = imageSkippedNote.trim() || null;
      summary.created++;
      logger.info(`Scheduler: scheduled ${entry.brand}/${entry.channel} @ ${dueAt} -> Buffer ${post.id} (awaiting approval)`);
    } catch (e) {
      const errStr = e && e.message ? e.message : String(e);
      await store.updateScheduledPost(row.id, { status: 'failed', error: errStr });
      item.status = 'failed';
      item.reason = errStr;
      summary.failed++;
      logger.error(`Scheduler: failed ${entry.brand}/${entry.channel} @ ${dueAt}: ${errStr}`);
    }

    summary.items.push(item);
    await sleep(baseDelayMs); // pace createPost calls within Buffer's rate window
  }

  return summary;
}

module.exports = { generateAndScheduleBatch, computeDueAt, calendarKey, submitToBuffer };
