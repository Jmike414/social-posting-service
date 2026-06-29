'use strict';

// Pure-Node MP4/MOV dimension reader. Parses the ISO Base Media File Format
// (ISOBMFF) box structure to extract video track width+height from the tkhd
// (Track Header Box). No binary dependencies — works on any Node >= 20.
//
// Reads only the first 8 MB so it stays fast even for large files. Streaming-
// optimised exports from InVideo and CapCut place the moov atom near the start,
// so 8 MB covers every realistic export without loading the whole file.
//
// Returns null if the file is not a recognisable MP4/MOV or parsing fails —
// callers treat that as "ratio unknown" and surface it to the operator rather
// than blocking the upload.

const fs = require('fs');

// Head read: covers front-loaded moov (stream-optimized InVideo/CapCut exports).
const HEAD_LIMIT = 8 * 1024 * 1024;
// Targeted second read when moov is back-loaded (default CapCut/encoder output
// where mdat precedes moov). We walk the head to locate moov's byte offset, then
// read exactly that box. 2 MB is a safe ceiling — production moov boxes are <200 KB.
const MOOV_READ_MAX = 2 * 1024 * 1024;

// ── Ratio rules ──────────────────────────────────────────────────────────────
//
// Each rule maps a pixel aspect ratio (w/h) range to:
//   ratioClass          — canonical string stored on the post record
//   label               — human-readable, shown in the console UI
//   eligibleDestinations — platform targets the video actually fits
//
// Tolerances are ±10 % of the canonical value to absorb slight encoding
// variations (e.g. 1080×1921 rounds to 9:16; 1920×1080 rounds to 16:9).
const RATIO_RULES = [
  {
    test: (r) => r <= 0.62,
    ratioClass: '9:16',
    label: '9:16 vertical',
    eligibleDestinations: ['ig_reel', 'fb_reel', 'ig_story', 'fb_story'],
  },
  {
    test: (r) => r > 0.62 && r <= 0.88,
    ratioClass: '4:5',
    label: '4:5 portrait',
    eligibleDestinations: ['ig_feed', 'fb_feed'],
  },
  {
    test: (r) => r > 0.88 && r <= 1.15,
    ratioClass: '1:1',
    label: '1:1 square',
    eligibleDestinations: ['ig_feed', 'fb_feed'],
  },
  {
    test: (r) => r > 1.15 && r <= 1.50,
    ratioClass: '4:3',
    label: '4:3 landscape',
    eligibleDestinations: ['fb_feed'],
  },
  {
    test: (r) => r > 1.50,
    ratioClass: '16:9',
    label: '16:9 widescreen',
    eligibleDestinations: ['linkedin'],
  },
];

function classifyRatio(w, h) {
  if (!w || !h || h === 0) {
    return { ratioClass: 'unknown', label: 'unknown aspect', eligibleDestinations: [] };
  }
  const r = w / h;
  for (const rule of RATIO_RULES) {
    if (rule.test(r)) {
      return {
        ratioClass: rule.ratioClass,
        label: rule.label,
        eligibleDestinations: rule.eligibleDestinations,
      };
    }
  }
  return { ratioClass: 'unknown', label: `${w}×${h}`, eligibleDestinations: [] };
}

// ── ISOBMFF box walker ───────────────────────────────────────────────────────
//
// Walks the flat list of boxes in `buf[offset..limit]`. Calls onBox(type, buf,
// dataOffset, dataEnd) for each box. Return false from onBox to stop early.
// Boxes with size=0 (box extends to EOF) or size=1 (64-bit size) are skipped —
// they do not appear in moov/trak/tkhd.
function walkBoxes(buf, offset, limit, onBox) {
  let pos = offset;
  while (pos + 8 <= Math.min(limit, buf.length)) {
    const size = buf.readUInt32BE(pos);
    const type = buf.subarray(pos + 4, pos + 8).toString('latin1');
    if (size < 8) break; // malformed or size=0 (EOF-extent, not in headers)
    const dataStart = pos + 8;
    const dataEnd = pos + size;
    if (onBox(type, buf, dataStart, Math.min(dataEnd, buf.length)) === false) return;
    pos += size;
  }
}

// ── tkhd parser ─────────────────────────────────────────────────────────────
//
// tkhd data layout (bytes relative to start of box data, i.e. after the 8-byte
// [size][type] header):
//
//   version 0  → width at offset 76, height at offset 80  (box data ≥ 84 bytes)
//   version 1  → width at offset 88, height at offset 92  (box data ≥ 96 bytes)
//
// Width and height are stored as 16.16 fixed-point (integer pixels = value >> 16).
function parseTkhd(buf, start, end) {
  if (start >= end || start >= buf.length) return null;
  const version = buf[start];
  let wOff, hOff, minLen;
  if (version === 0) {
    wOff = start + 76; hOff = start + 80; minLen = 84;
  } else if (version === 1) {
    wOff = start + 88; hOff = start + 92; minLen = 96;
  } else {
    return null;
  }
  if (end - start < minLen) return null;
  if (hOff + 4 > buf.length) return null;
  const w = buf.readUInt32BE(wOff) >>> 16;
  const h = buf.readUInt32BE(hOff) >>> 16;
  if (w === 0 || h === 0) return null;
  return { w, h };
}

// ── Public API ───────────────────────────────────────────────────────────────

// Extract dimensions from a moov→trak→tkhd chain inside `buf[start..end]`.
// Updates `best` in place (caller provides a { value } box to mutate).
function extractFromMoov(buf, start, end, bestBox) {
  walkBoxes(buf, start, end, (t2, b2, s2, e2) => {
    if (t2 !== 'trak') return;
    walkBoxes(b2, s2, e2, (t3, b3, s3, e3) => {
      if (t3 !== 'tkhd') return;
      const dim = parseTkhd(b3, s3, e3);
      if (dim && (!bestBox.value || dim.w * dim.h > bestBox.value.w * bestBox.value.h)) {
        bestBox.value = dim;
      }
      return false; // one tkhd per trak
    });
  });
}

// Synchronous probe — exported separately so tests can call it directly without
// the async wrapper.
//
// Two-window strategy:
//   1. Head read (first HEAD_LIMIT bytes) — finds moov when the file is
//      stream-optimized (moov before mdat). Covers all InVideo Veo exports and
//      CapCut "optimize for streaming" exports.
//   2. Targeted moov read — when head scan finds no moov, walks the top-level
//      box headers in the head to compute moov's file offset, then reads exactly
//      that box. Covers default CapCut / generic encoder output where mdat comes
//      first and moov is at the end of the file.
function probeSync(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const { size } = fs.fstatSync(fd);

    // ── Pass 1: head read ──────────────────────────────────────────────────
    const headSize = Math.min(size, HEAD_LIMIT);
    const headBuf = Buffer.allocUnsafe(headSize);
    fs.readSync(fd, headBuf, 0, headSize, 0);

    const bestBox = { value: null };

    walkBoxes(headBuf, 0, headBuf.length, (t1, b, s1, e1) => {
      if (t1 !== 'moov') return;
      extractFromMoov(b, s1, e1, bestBox);
      return false; // stop after first moov
    });

    // ── Pass 2: targeted seek when moov is back-loaded ─────────────────────
    // Walk the top-level box-header list in the head buffer to compute the
    // file byte-offset where the next top-level box starts after the head
    // window ends. For default-encoded files (ftyp → free → mdat → moov) this
    // lands exactly at the start of moov.
    if (!bestBox.value && size > HEAD_LIMIT) {
      let pos = 0;
      let moovFileOffset = null;
      while (pos + 8 <= headBuf.length) {
        const boxSize = headBuf.readUInt32BE(pos);
        if (boxSize < 8) break; // malformed
        const boxType = headBuf.subarray(pos + 4, pos + 8).toString('latin1');
        if (boxType === 'moov') break; // already handled in pass 1
        const next = pos + boxSize;
        if (next >= HEAD_LIMIT) {
          // This box extends beyond (or ends exactly at) the head window.
          // The next top-level box begins at file offset `next`.
          moovFileOffset = next;
          break;
        }
        pos = next;
      }

      if (moovFileOffset !== null && moovFileOffset < size) {
        const readSize = Math.min(MOOV_READ_MAX, size - moovFileOffset);
        if (readSize >= 8) {
          const moovBuf = Buffer.allocUnsafe(readSize);
          fs.readSync(fd, moovBuf, 0, readSize, moovFileOffset);
          walkBoxes(moovBuf, 0, moovBuf.length, (t1, b, s1, e1) => {
            if (t1 !== 'moov') return;
            extractFromMoov(b, s1, e1, bestBox);
            return false;
          });
        }
      }
    }

    fs.closeSync(fd);
    fd = undefined;

    if (!bestBox.value) return null;
    const { w, h } = bestBox.value;
    const { ratioClass, label, eligibleDestinations } = classifyRatio(w, h);
    return {
      width: w,
      height: h,
      detectedRatio: ratioClass,
      ratioLabel: label,
      eligibleDestinations,
    };
  } catch (_err) {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

// Async wrapper so callers can await it and the interface stays consistent with
// future ffprobe-based fallbacks.
async function probe(filePath) {
  return probeSync(filePath);
}

// Convenience: classify a pixel dimension pair without reading a file.
// Used client-side via the API and in tests.
function classify(width, height) {
  return classifyRatio(width, height);
}

module.exports = { probe, probeSync, classify, classifyRatio, RATIO_RULES };
