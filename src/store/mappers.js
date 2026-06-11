'use strict';

const crypto = require('crypto');

// Shared row<->object mapping and id/time helpers. Both stores persist the same
// logical shape: JSON fields as TEXT, auto_publish as 0/1, timestamps as ISO TEXT.
// Keeping these identical is what makes SqliteStore and PgStore interchangeable.

function nowIso() {
  return new Date().toISOString();
}
function newId() {
  return crypto.randomUUID();
}

const POST_JSON_FIELDS = ['channel_ids', 'buffer_post_ids'];

function rowToPost(row) {
  if (!row) return null;
  const out = { ...row };
  out.auto_publish = !!row.auto_publish;
  out.attempts = Number(row.attempts || 0);
  for (const f of POST_JSON_FIELDS) {
    if (typeof row[f] === 'string') {
      try {
        out[f] = JSON.parse(row[f]);
      } catch {
        out[f] = f === 'buffer_post_ids' ? {} : [];
      }
    } else if (row[f] == null) {
      out[f] = f === 'buffer_post_ids' ? {} : [];
    }
  }
  return out;
}

// Normalises an incoming create payload into the flat column values both stores
// insert. JSON fields are serialised; auto_publish coerced to 0/1.
function postInsertValues(input, ts) {
  return {
    id: input.id || newId(),
    brand: String(input.brand).toLowerCase(),
    destination: input.destination || 'buffer',
    brief: input.brief || '',
    copy: input.copy ?? null,
    image_path: input.image_path ?? null,
    image_alt: input.image_alt ?? null,
    intended_post_time: input.intended_post_time ?? null,
    auto_publish: input.auto_publish ? 1 : 0,
    state: input.state || 'drafted',
    channel_ids: JSON.stringify(input.channel_ids || []),
    buffer_post_ids: JSON.stringify(input.buffer_post_ids || {}),
    scheduling_mode: input.scheduling_mode ?? null,
    attempts: input.attempts || 0,
    error: input.error ?? null,
    created_at: ts,
    updated_at: ts,
  };
}

// Applies a partial patch to an existing row, serialising JSON fields and
// coercing auto_publish, returning the full column set to write back.
function applyPostPatch(current, patch, ts) {
  const next = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'auto_publish') next[k] = v ? 1 : 0;
    else if (POST_JSON_FIELDS.includes(k)) next[k] = JSON.stringify(v);
    else next[k] = v;
  }
  next.updated_at = ts;
  return next;
}

const POST_COLUMNS = [
  'id', 'brand', 'destination', 'brief', 'copy', 'image_path', 'image_alt', 'intended_post_time',
  'auto_publish', 'state', 'channel_ids', 'buffer_post_ids', 'scheduling_mode', 'attempts', 'error',
  'created_at', 'updated_at',
];

module.exports = { nowIso, newId, rowToPost, postInsertValues, applyPostPatch, POST_JSON_FIELDS, POST_COLUMNS };
