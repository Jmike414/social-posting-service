'use strict';

// Tests for video-probe.js — pure-Node MP4 dimension reader + ratio delegator.
//
// Each test builds a minimal ISOBMFF (MP4) byte buffer that contains exactly
// the moov → trak → tkhd boxes the prober needs, then calls probeSync directly
// so we get deterministic results without touching the filesystem.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { probeSync, classify, classifyRatio } = require('../src/video-probe');

// ── Synthetic MP4 builder ──────────────────────────────────────────────────
// Writes a minimal but structurally valid ISOBMFF file:
//   ftyp (file-type declaration, required by strict parsers)
//   moov
//     trak
//       tkhd  (version 0, with the supplied pixel dimensions)

function writeUint32BE(buf, offset, value) {
  buf.writeUInt32BE(value >>> 0, offset);
}

// 16.16 fixed-point encoding used by tkhd for width/height.
function fixedPoint(px) {
  return (px << 16) >>> 0;
}

function buildTkhdV0(widthPx, heightPx) {
  const size = 8 + 84; // box header (8) + tkhd data (84)
  const buf = Buffer.alloc(size, 0);
  writeUint32BE(buf, 0, size);
  buf.write('tkhd', 4, 'ascii');
  // version=0, flags=0x000003 (track enabled + in movie)
  buf[8] = 0x00;
  buf[9] = 0x00; buf[10] = 0x00; buf[11] = 0x03;
  // creation_time, modification_time, track_id, reserved, duration, reserved×2,
  // layer, alt_group, volume, reserved, matrix (36 bytes) — all zero works
  // width at offset 8+76 = 84, height at 8+80 = 88 (from start of buffer)
  writeUint32BE(buf, 8 + 76, fixedPoint(widthPx));
  writeUint32BE(buf, 8 + 80, fixedPoint(heightPx));
  return buf;
}

function buildTrak(tkhdBuf) {
  const inner = tkhdBuf;
  const size = 8 + inner.length;
  const header = Buffer.alloc(8);
  writeUint32BE(header, 0, size);
  header.write('trak', 4, 'ascii');
  return Buffer.concat([header, inner]);
}

function buildMoov(trakBuf) {
  const size = 8 + trakBuf.length;
  const header = Buffer.alloc(8);
  writeUint32BE(header, 0, size);
  header.write('moov', 4, 'ascii');
  return Buffer.concat([header, trakBuf]);
}

function buildFtyp() {
  const buf = Buffer.alloc(20, 0);
  writeUint32BE(buf, 0, 20);
  buf.write('ftyp', 4, 'ascii');
  buf.write('mp42', 8, 'ascii');
  return buf;
}

function syntheticMp4(widthPx, heightPx) {
  const ftyp = buildFtyp();
  const tkhd = buildTkhdV0(widthPx, heightPx);
  const trak = buildTrak(tkhd);
  const moov = buildMoov(trak);
  return Buffer.concat([ftyp, moov]);
}

// Write a synthetic file to a temp path, run probeSync, clean up.
function probePixels(widthPx, heightPx) {
  const tmp = path.join(os.tmpdir(), `pz-probe-test-${widthPx}x${heightPx}-${Date.now()}.mp4`);
  fs.writeFileSync(tmp, syntheticMp4(widthPx, heightPx));
  try {
    return probeSync(tmp);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

// ── classifyRatio (pure function) ─────────────────────────────────────────

describe('classifyRatio', () => {
  it('1080×1920 (9:16 exact) → 9:16 vertical', () => {
    const r = classifyRatio(1080, 1920);
    assert.equal(r.ratioClass, '9:16');
    assert.deepEqual(r.eligibleDestinations, ['ig_reel', 'fb_reel', 'ig_story', 'fb_story']);
  });

  it('1080×1921 (near-9:16) → 9:16 vertical (tolerance)', () => {
    const r = classifyRatio(1080, 1921);
    assert.equal(r.ratioClass, '9:16');
  });

  it('1080×1350 (4:5) → ig_feed / fb_feed', () => {
    const r = classifyRatio(1080, 1350);
    assert.equal(r.ratioClass, '4:5');
    assert(r.eligibleDestinations.includes('ig_feed'));
    assert(r.eligibleDestinations.includes('fb_feed'));
  });

  it('1080×1080 (1:1 square) → ig_feed / fb_feed', () => {
    const r = classifyRatio(1080, 1080);
    assert.equal(r.ratioClass, '1:1');
  });

  it('1920×1080 (16:9) → linkedin only', () => {
    const r = classifyRatio(1920, 1080);
    assert.equal(r.ratioClass, '16:9');
    assert.deepEqual(r.eligibleDestinations, ['linkedin']);
    // Confirm IG Reel is NOT in eligible destinations — the key routing assertion.
    assert(!r.eligibleDestinations.includes('ig_reel'), 'ig_reel must NOT be eligible for 16:9');
  });

  it('1280×720 (16:9 variant) → linkedin', () => {
    const r = classifyRatio(1280, 720);
    assert.equal(r.ratioClass, '16:9');
  });

  it('0×0 → unknown, empty eligible', () => {
    const r = classifyRatio(0, 0);
    assert.equal(r.ratioClass, 'unknown');
    assert.deepEqual(r.eligibleDestinations, []);
  });
});

// classify() is an alias — spot-check
describe('classify()', () => {
  it('delegates to classifyRatio', () => {
    const { classify: c } = require('../src/video-probe');
    assert.equal(c(1080, 1920).ratioClass, '9:16');
    assert.equal(c(1920, 1080).ratioClass, '16:9');
  });
});

// ── probeSync (filesystem) ────────────────────────────────────────────────

describe('probeSync — synthetic MP4 files [VERIFIED-BY-EXECUTION]', () => {
  it('9:16 file (1080×1920) → detectedRatio=9:16, ig_reel eligible', () => {
    const result = probePixels(1080, 1920);
    assert.notEqual(result, null, 'probe must return a result');
    assert.equal(result.width, 1080);
    assert.equal(result.height, 1920);
    assert.equal(result.detectedRatio, '9:16');
    assert(result.eligibleDestinations.includes('ig_reel'), 'ig_reel must be eligible for 9:16');
    assert(!result.eligibleDestinations.includes('linkedin'), 'linkedin must NOT be eligible for 9:16');
  });

  it('16:9 file (1920×1080) → detectedRatio=16:9, linkedin eligible, ig_reel NOT eligible [VERIFIED-BY-EXECUTION]', () => {
    const result = probePixels(1920, 1080);
    assert.notEqual(result, null, 'probe must return a result');
    assert.equal(result.width, 1920);
    assert.equal(result.height, 1080);
    assert.equal(result.detectedRatio, '16:9');
    assert(result.eligibleDestinations.includes('linkedin'), 'linkedin must be eligible for 16:9');
    // THE KEY ROUTING ASSERTION: ig_reel must be withheld, not offered.
    assert(!result.eligibleDestinations.includes('ig_reel'), 'ig_reel must NOT be eligible for 16:9 — delegator routes, never converts');
    assert(!result.eligibleDestinations.includes('fb_reel'), 'fb_reel must NOT be eligible for 16:9');
  });

  it('1:1 file (1080×1080) → ig_feed + fb_feed, not reel', () => {
    const result = probePixels(1080, 1080);
    assert.notEqual(result, null);
    assert.equal(result.detectedRatio, '1:1');
    assert(result.eligibleDestinations.includes('ig_feed'));
    assert(!result.eligibleDestinations.includes('ig_reel'));
  });

  it('non-MP4 garbage data → null (graceful fallback)', () => {
    const tmp = path.join(os.tmpdir(), `pz-probe-garbage-${Date.now()}.mp4`);
    fs.writeFileSync(tmp, Buffer.from('not an mp4 file at all'));
    try {
      const result = probeSync(tmp);
      assert.equal(result, null, 'garbage file must return null, not throw');
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  });

  it('non-existent file → null (graceful fallback)', () => {
    const result = probeSync('/does/not/exist/fake.mp4');
    assert.equal(result, null);
  });
});

// ── BufferPublisher video routing ────────────────────────────────────────────
// Verify the publisher skips channels whose service doesn't match the ratio.

describe('BufferPublisher video routing [VERIFIED-BY-EXECUTION]', () => {
  const { BufferPublisher } = require('../src/publisher/BufferPublisher');

  // Minimal fake store and client.
  function makeStore(channels) {
    return {
      getPost: async () => null,
      updatePost: async (id, patch) => ({ id, ...patch }),
      resolveChannelsForBrand: async () => channels,
    };
  }

  const posted = [];
  function makeClient(channels) {
    return {
      buildImageAsset: ({ url }) => ({ image: { url } }),
      buildVideoAsset: ({ url }) => ({ video: { url } }),
      buildPostMetadata: (svc, opts = {}) => {
        if (svc === 'instagram') return { instagram: { type: opts.isReel ? 'reel' : 'post', shouldShareToFeed: true } };
        if (svc === 'facebook') return { facebook: { type: opts.isReel ? 'reel' : 'post' } };
        return null;
      },
      buildCreatePostInput: ({ channelId, text, mode, dueAt, assets, metadata }) => ({ channelId, text, mode, assets, metadata }),
      createPost: async (input) => {
        posted.push(input);
        return { post: { id: `bp-${input.channelId}` } };
      },
      findPostByText: async () => null,
      BufferError: class extends Error { constructor(msg) { super(msg); this.code = 'CLIENT_ERROR'; this.retryable = false; } },
    };
  }

  it('9:16 video: posts to instagram (reel) and facebook (reel), skips linkedin', async () => {
    posted.length = 0;
    const channels = [
      { id: 'ig_ch', service: 'instagram', name: 'IG' },
      { id: 'fb_ch', service: 'facebook',  name: 'FB' },
      { id: 'li_ch', service: 'linkedin',  name: 'LI' },
    ];
    const store = makeStore(channels);
    const client = makeClient(channels);
    const pub = new BufferPublisher({ store, client });

    const post = {
      id: 'p1', image_path: 'https://example.com/reel.mp4', image_alt: null,
      media_type: 'video', detected_ratio: '9:16',
      eligible_destinations: ['ig_reel', 'fb_reel', 'ig_story', 'fb_story'],
      copy: 'Test reel',
      channel_ids: ['ig_ch', 'fb_ch', 'li_ch'],
      buffer_post_ids: {}, attempts: 0,
    };

    await pub.publish(post);

    const submittedChannels = posted.map((p) => p.channelId);
    assert(submittedChannels.includes('ig_ch'), 'Instagram must be included for 9:16 reel');
    assert(submittedChannels.includes('fb_ch'), 'Facebook must be included for 9:16 reel');
    assert(!submittedChannels.includes('li_ch'), 'LinkedIn must be SKIPPED for 9:16 reel [VERIFIED-BY-EXECUTION]');

    // Confirm reel metadata was sent to Instagram.
    const igPost = posted.find((p) => p.channelId === 'ig_ch');
    assert.equal(igPost.metadata.instagram.type, 'reel', 'Instagram must receive type:reel for 9:16 video');
  });

  it('16:9 video: posts to linkedin, skips instagram and facebook [VERIFIED-BY-EXECUTION]', async () => {
    posted.length = 0;
    const channels = [
      { id: 'ig_ch', service: 'instagram', name: 'IG' },
      { id: 'fb_ch', service: 'facebook',  name: 'FB' },
      { id: 'li_ch', service: 'linkedin',  name: 'LI' },
    ];
    const store = makeStore(channels);
    const client = makeClient(channels);
    const pub = new BufferPublisher({ store, client });

    const post = {
      id: 'p2', image_path: 'https://example.com/widescreen.mp4', image_alt: null,
      media_type: 'video', detected_ratio: '16:9',
      eligible_destinations: ['linkedin'],
      copy: 'Test wide video',
      channel_ids: ['ig_ch', 'fb_ch', 'li_ch'],
      buffer_post_ids: {}, attempts: 0,
    };

    await pub.publish(post);

    const submittedChannels = posted.map((p) => p.channelId);
    assert(!submittedChannels.includes('ig_ch'), 'Instagram must be WITHHELD for 16:9 video — delegator routes, never converts');
    assert(!submittedChannels.includes('fb_ch'), 'Facebook Reel must be WITHHELD for 16:9 video');
    assert(submittedChannels.includes('li_ch'), 'LinkedIn must be included for 16:9 video');
  });

  it('video with unknown ratio (probe failed) → all services allowed', async () => {
    posted.length = 0;
    const channels = [
      { id: 'ig_ch', service: 'instagram', name: 'IG' },
      { id: 'fb_ch', service: 'facebook',  name: 'FB' },
    ];
    const store = makeStore(channels);
    const client = makeClient(channels);
    const pub = new BufferPublisher({ store, client });

    const post = {
      id: 'p3', image_path: 'https://example.com/unknown.mp4', image_alt: null,
      media_type: 'video', detected_ratio: null,
      eligible_destinations: [], // empty = unknown ratio
      copy: 'Unknown ratio video',
      channel_ids: ['ig_ch', 'fb_ch'],
      buffer_post_ids: {}, attempts: 0,
    };

    await pub.publish(post);

    const submittedChannels = posted.map((p) => p.channelId);
    assert(submittedChannels.includes('ig_ch'), 'IG must be allowed when ratio is unknown');
    assert(submittedChannels.includes('fb_ch'), 'FB must be allowed when ratio is unknown');
  });
});
