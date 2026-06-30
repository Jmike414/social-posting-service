'use strict';

const { config } = require('../config');

const BASE = 'https://api.heygen.com';

function apiKey() {
  const key = config.heygen && config.heygen.apiKey;
  if (!key) throw new Error('HEYGEN_API_KEY is not configured');
  return key;
}

async function heygenPost(urlPath, body) {
  const res = await fetch(`${BASE}${urlPath}`, {
    method: 'POST',
    headers: { 'X-Api-Key': apiKey(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HeyGen POST ${urlPath} → ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function heygenGet(urlPath) {
  const res = await fetch(`${BASE}${urlPath}`, {
    headers: { 'X-Api-Key': apiKey() },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HeyGen GET ${urlPath} → ${res.status}: ${text}`);
  return JSON.parse(text);
}

// Creates a new avatar video render job. Returns { video_id, status }.
async function createVideo({ avatarId, voiceId, script, aspectRatio = '9:16', resolution = '1080p' }) {
  const result = await heygenPost('/v3/videos', {
    type: 'avatar',
    avatar_id: avatarId,
    script,
    voice_id: voiceId,
    aspect_ratio: aspectRatio,
    resolution,
    engine: { type: 'avatar_iv' },
  });
  return result.data; // { video_id, status }
}

// Polls a render job. Returns { status, video_url?, duration?, failure_code?, failure_message? }.
async function getVideoStatus(videoId) {
  const result = await heygenGet(`/v3/videos/${videoId}`);
  return result.data;
}

module.exports = { createVideo, getVideoStatus };
