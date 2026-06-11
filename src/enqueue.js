'use strict';

const { isBrand } = require('./config');
const { STATES } = require('./state');

// The ENTIRE programmatic contract. A caller (the console, or the engine via
// POST /enqueue) creates work by inserting one `drafted` social_posts row through
// this function. Nothing else is a supported inbound surface.
//
//   enqueue(store, { brand, brief, intended_post_time?, image?, image_alt?,
//                    auto_publish?, destination? }) -> created record (state 'drafted')
//
//   brand        : 'propzombie' | 'crewmando'                 (required)
//   brief        : free-text brief for the drafter            (required)
//   destination  : 'buffer' (default) | 'manual_fb_group' | 'manual_whatsapp'
//   image        : public image URL OR local upload path      (optional)
//   image_alt    : alt text for accessibility                 (optional)
//   intended_post_time : ISO 8601 — honored as the scheduled time (optional)
//   auto_publish : bool, default false — when true, skips human review

const DESTINATIONS = ['buffer', 'manual_fb_group', 'manual_whatsapp'];

async function enqueue(store, input = {}) {
  const brand = String(input.brand || '').toLowerCase();
  if (!isBrand(brand)) {
    throw Object.assign(new Error(`Unknown brand "${input.brand}". Expected one of: propzombie, crewmando.`), { statusCode: 400 });
  }
  const brief = String(input.brief || '').trim();
  if (!brief) {
    throw Object.assign(new Error('brief is required.'), { statusCode: 400 });
  }
  const destination = input.destination || 'buffer';
  if (!DESTINATIONS.includes(destination)) {
    throw Object.assign(new Error(`Invalid destination "${destination}".`), { statusCode: 400 });
  }
  let intended = null;
  if (input.intended_post_time) {
    const d = new Date(input.intended_post_time);
    if (Number.isNaN(d.getTime())) {
      throw Object.assign(new Error('intended_post_time is not a valid date.'), { statusCode: 400 });
    }
    intended = d.toISOString();
  }

  return store.createPost({
    brand,
    destination,
    brief,
    image_path: input.image || null,
    image_alt: input.image_alt || null,
    intended_post_time: intended,
    auto_publish: !!input.auto_publish,
    ai_draft: !!input.ai_draft, // false (default) => brief is posted verbatim; true => AI rewrites it
    state: STATES.DRAFTED,
  });
}

module.exports = { enqueue, DESTINATIONS };
