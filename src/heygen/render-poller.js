'use strict';

const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { createWriteStream } = require('fs');

const { probe: probeVideo } = require('../video-probe');
const { logger } = require('../logger');
const { nowIso, newId } = require('../store/mappers');
const heygenClient = require('./heygen-client');

const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');
const POLL_INTERVAL_MS = 15_000;
const MAX_POLL_MS = 30 * 60 * 1000;

async function downloadVideo(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Video download failed: HTTP ${res.status}`);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const out = createWriteStream(destPath);
  await pipeline(Readable.fromWeb(res.body), out);
}

async function ingestCompletedVideo({ job, videoUrl, durationSec, store }) {
  const filename = `${newId()}.mp4`;
  const destPath = path.join(UPLOADS_DIR, filename);
  logger.info(`HeyGen job ${job.id}: downloading → ${filename}`);
  await downloadVideo(videoUrl, destPath);

  const probeResult = await probeVideo(destPath);
  const detectedRatio = (probeResult && probeResult.detectedRatio) || job.aspect_ratio || '9:16';
  const eligibleDestinations = (probeResult && probeResult.eligibleDestinations) || [];

  const post = await store.createPost({
    brand: job.brand,
    destination: 'buffer',
    brief: job.brief,
    copy: job.script,
    image_path: `uploads/${filename}`,
    image_alt: null,
    intended_post_time: null,
    auto_publish: false,
    ai_draft: false,
    state: 'awaiting_review',
    media_type: 'video',
    detected_ratio: detectedRatio,
    eligible_destinations: eligibleDestinations,
    source: 'heygen',
  });

  await store.updateHeygenJob(job.id, {
    status: 'completed',
    video_url: videoUrl,
    duration_sec: durationSec || null,
    post_id: post.id,
  });

  logger.info(`HeyGen job ${job.id}: ingested → post ${post.id} (awaiting_review, ratio=${detectedRatio})`);
  return post;
}

async function pollJob(jobId, deps) {
  const { store } = deps;
  const start = Date.now();

  while (Date.now() - start < MAX_POLL_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    const job = await store.getHeygenJob(jobId);
    if (!job || job.status !== 'rendering') return;

    try {
      const data = await heygenClient.getVideoStatus(job.heygen_video_id);
      logger.info(`HeyGen job ${jobId}: heygen_status=${data.status}`);

      if (data.status === 'completed') {
        await ingestCompletedVideo({ job, videoUrl: data.video_url, durationSec: data.duration || null, store });
        return;
      }
      if (data.status === 'failed') {
        const errMsg = data.failure_message || data.failure_code || 'unknown failure';
        await store.updateHeygenJob(jobId, { status: 'failed', error: errMsg });
        logger.error(`HeyGen job ${jobId} failed: ${errMsg}`);
        return;
      }
      // waiting / processing — keep looping
    } catch (e) {
      logger.warn(`HeyGen poll error for ${jobId}: ${e.message}`);
    }
  }

  await store.updateHeygenJob(jobId, { status: 'failed', error: 'render timeout (30 min)' });
  logger.error(`HeyGen job ${jobId}: timed out`);
}

async function resumePendingJobs(deps) {
  const jobs = await deps.store.listHeygenJobs({ status: 'rendering' });
  if (!jobs.length) return;
  logger.info(`HeyGen: resuming polling for ${jobs.length} in-flight job(s)`);
  for (const job of jobs) {
    pollJob(job.id, deps).catch((e) => logger.error(`HeyGen resume poll failed ${job.id}: ${e.message}`));
  }
}

module.exports = { pollJob, resumePendingJobs };
