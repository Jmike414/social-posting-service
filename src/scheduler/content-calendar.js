'use strict';

// Source of truth for what gets generated + scheduled.
// Each entry = one post. The drafter expands `brief` into final copy at
// generation time; dueAt is computed from dayOffset + slot (Central time, DST-aware).
//
// THIS FILE IS INTENTIONALLY EDITABLE. Add a full month of entries here; the
// scheduler reads whatever is in CALENDAR. An entry whose `channel` isn't a
// registered Buffer channel for its brand is skipped (with a logged note) — e.g.
// linkedin/instagram until those channels are connected + registered.

const TIMEZONE = 'America/Chicago'; // Central — Houston/Austin/SA

// Posting slots per platform (local Central time, 24h). Used to compute dueAt.
const SLOTS = {
  facebook: '09:00',
  instagram: '11:00',
  linkedin: '08:00',
};

// The rolling calendar. dayOffset is days from the batch start date
// (0 = first day of the batch). Add/remove freely.
const CALENDAR = [
  // ---- PropZombie ----
  { brand: 'propzombie', channel: 'facebook', metro: 'houston',
    dayOffset: 0, slot: 'facebook',
    brief: 'Houston landlords: free 3-minute property health check '
         + 'flags your next likely repair before it becomes a $4k '
         + 'emergency. Drive to propzombie.com free tools. Warm, '
         + 'direct, no hype.' },
  { brand: 'propzombie', channel: 'linkedin', metro: 'all',
    dayOffset: 0, slot: 'linkedin',
    brief: 'Maintenance is the #1 reason rental investors '
         + 'underperform projections. PropZombie free tools: health '
         + 'reports, invoice review, portfolio risk. Professional '
         + 'tone for investors/PMs.' },
  { brand: 'propzombie', channel: 'facebook', metro: 'austin',
    dayOffset: 2, slot: 'facebook',
    brief: 'Austin rental owners: maintenance costs running high. '
         + 'Free portfolio risk assessment shows where exposure is. '
         + 'propzombie.com. Direct, useful.' },
  // ---- CrewMando ----
  { brand: 'crewmando', channel: 'facebook', metro: 'houston',
    dayOffset: 1, slot: 'facebook',
    brief: 'Houston contractors/PMs: stop posting in 6 Facebook '
         + 'groups to find Spanish-speaking trades. CrewMando '
         + 'matches vetted workers, bilingual coordination, show-up '
         + 'deposit. First job free. crewmando.com.' },
  { brand: 'crewmando', channel: 'facebook', metro: 'houston',
    dayOffset: 1, slot: 'instagram',
    brief: 'Spanish worker recruitment post for Houston. ES '
         + 'language. Trabajos de construccion, registro gratis, '
         + 'pago garantizado. crewmando.com/join.html. Warm, '
         + 'community tone.' },
  // ... owner extends this list freely
];

module.exports = { CALENDAR, SLOTS, TIMEZONE };
