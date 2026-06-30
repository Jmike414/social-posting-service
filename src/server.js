'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const multer = require('multer');

const { config, validate, isBrand } = require('./config');
const { probe: probeVideo } = require('./video-probe');
const { mediaTypeFromPath } = require('./store/mappers');
const { logger } = require('./logger');
const { createStore } = require('./db');
const { createDrafter } = require('./drafter');
const { BufferPublisher } = require('./publisher/BufferPublisher');
const { enqueue } = require('./enqueue');
const worker = require('./worker');
const scheduler = require('./scheduler/scheduler');
const { fetchAndStoreMetrics } = require('./metrics/MetricsFetcher');
const bufferClient = require('./publisher/buffer-client');
const { STATES, canTransition } = require('./state');
const heygenClient = require('./heygen/heygen-client');
const { pollJob: heygenPollJob, resumePendingJobs: heygenResume } = require('./heygen/render-poller');

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// ── Auth helpers ─────────────────────────────────────────────────────────────
function checkPassword(pw) {
  // Returns the matched user role, or null. Constant-time compare against each
  // configured password. CONSOLE_PASSWORD = primary operator; CONSOLE_PASSWORD_ES
  // = optional Spanish-copy reviewer (CrewMando).
  const candidates = [
    ['operator', config.consolePassword],
    ['reviewer_es', config.consolePasswordEs],
  ].filter(([, secret]) => secret);
  for (const [role, secret] of candidates) {
    const a = Buffer.from(String(pw));
    const b = Buffer.from(String(secret));
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return role;
  }
  return null;
}

function createApp(deps) {
  const { store } = deps;
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(
    session({
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 12 },
    })
  );

  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, UPLOADS_DIR),
      filename: (req, file, cb) => {
        const ext = (path.extname(file.originalname) || '').slice(0, 10).replace(/[^.a-z0-9]/gi, '');
        cb(null, `${crypto.randomUUID()}${ext}`);
      },
    }),
    // 500 MB covers typical 60-second 1080p Reel exports from InVideo / CapCut.
    limits: { fileSize: 500 * 1024 * 1024 },
  });
  // Accept both 'media' (new canonical) and 'image' (legacy form field name).
  const uploadMedia = upload.fields([{ name: 'media', maxCount: 1 }, { name: 'image', maxCount: 1 }]);

  // Uploaded images are served publicly so Buffer can fetch them by URL.
  app.use('/uploads', express.static(UPLOADS_DIR));
  app.use('/assets', express.static(PUBLIC_DIR));

  // Fire-and-forget worker nudge. In production, deps.nudge is wired to the
  // worker's tick so the running flag applies (set by start() after createApp).
  // Falls back to processOnce for test environments that don't start the worker.
  function nudge() {
    if (typeof deps.nudge === 'function') {
      deps.nudge();
    } else {
      worker.processOnce(deps).catch((e) => logger.error(`nudge error: ${e.message}`));
    }
  }

  function requireAuth(req, res, next) {
    if (req.session && req.session.role) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthenticated' });
    return res.redirect('/login');
  }

  function requireServiceToken(req, res, next) {
    if (!config.serviceToken) return res.status(404).json({ error: 'enqueue endpoint disabled (no SERVICE_TOKEN configured)' });
    const provided = req.get('x-service-token') || '';
    const a = Buffer.from(provided);
    const b = Buffer.from(config.serviceToken);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
    return res.status(401).json({ error: 'invalid service token' });
  }

  // ── Public ─────────────────────────────────────────────────────────────────
  app.get('/health', (req, res) => res.json({ ok: true, service: 'social-posting-service' }));

  app.get('/login', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));
  app.post('/login', (req, res) => {
    const role = checkPassword(req.body && req.body.password);
    if (!role) return res.status(401).json({ error: 'invalid password' });
    req.session.role = role;
    res.json({ ok: true, role });
  });
  app.post('/logout', (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
  });

  // ── Programmatic enqueue (the one inbound surface for the engine) ────────────
  app.post('/enqueue', requireServiceToken, async (req, res) => {
    try {
      const record = await enqueue(store, req.body || {});
      nudge();
      res.status(201).json({ id: record.id, state: record.state });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── Console API (auth) ───────────────────────────────────────────────────────
  app.get('/', requireAuth, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'console.html')));

  app.post('/api/compose', requireAuth, uploadMedia, async (req, res) => {
    try {
      const body = req.body || {};
      // Accept 'media' (new) or 'image' (legacy) field name.
      const uploadedFile = (req.files && (req.files.media || req.files.image) || [])[0] || null;
      const mediaLocalPath = uploadedFile ? path.join(UPLOADS_DIR, uploadedFile.filename) : null;
      const mediaServePath = uploadedFile ? `uploads/${uploadedFile.filename}` : null;

      let mediaType = null;
      let detectedRatio = null;
      let eligibleDestinations = [];

      if (uploadedFile) {
        mediaType = mediaTypeFromPath(uploadedFile.originalname);
        if (mediaType === 'video') {
          const probeResult = await probeVideo(mediaLocalPath);
          if (probeResult) {
            detectedRatio = probeResult.detectedRatio;
            eligibleDestinations = probeResult.eligibleDestinations;
            logger.info(`Video probe: ${uploadedFile.filename} → ${probeResult.width}×${probeResult.height} (${detectedRatio})`);
          } else {
            logger.warn(`Video probe failed for ${uploadedFile.filename} — ratio unknown, all destinations offered`);
          }
        }
      }

      const record = await enqueue(store, {
        brand: body.brand,
        brief: body.brief,
        destination: body.destination || 'buffer',
        intended_post_time: body.intended_post_time || null,
        image: mediaServePath,
        image_alt: body.image_alt || null,
        auto_publish: body.auto_publish === 'true' || body.auto_publish === true || body.auto_publish === 'on',
        ai_draft: body.ai_draft === 'true' || body.ai_draft === true || body.ai_draft === 'on',
        media_type: mediaType,
        detected_ratio: detectedRatio,
        eligible_destinations: eligibleDestinations,
      });
      nudge();
      res.status(201).json({ id: record.id, state: record.state, detected_ratio: detectedRatio, eligible_destinations: eligibleDestinations });
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  app.get('/api/posts', requireAuth, async (req, res) => {
    const state = req.query.state;
    const posts = state ? await store.listPosts({ state, limit: 100 }) : await store.listPosts({ limit: 50 });
    res.json({ posts: posts.map((p) => publicPost(p)) });
  });

  app.post('/api/posts/:id/approve', requireAuth, async (req, res) => {
    // Atomic: only transitions awaiting_review -> queued. Two concurrent taps
    // both executing before either write commits will each see awaiting_review,
    // but only one UPDATE wins — the second gets 0 rows and returns 409.
    const approved = await store.approvePost(req.params.id);
    if (!approved) {
      const post = await store.getPost(req.params.id);
      if (!post) return res.status(404).json({ error: 'not found' });
      return res.status(409).json({ error: `cannot approve from state ${post.state}` });
    }
    nudge();
    res.json({ ok: true });
  });

  app.post('/api/posts/:id/edit', requireAuth, async (req, res) => {
    const post = await store.getPost(req.params.id);
    if (!post) return res.status(404).json({ error: 'not found' });
    if (post.state !== STATES.AWAITING_REVIEW) {
      return res.status(409).json({ error: `can only edit copy while awaiting_review (is ${post.state})` });
    }
    const copy = (req.body && req.body.copy) || '';
    await store.updatePost(post.id, { copy }); // stays awaiting_review
    res.json({ ok: true, post: publicPost(await store.getPost(post.id)) });
  });

  app.post('/api/posts/:id/reject', requireAuth, async (req, res) => {
    const post = await store.getPost(req.params.id);
    if (!post) return res.status(404).json({ error: 'not found' });
    if (!canTransition(post.state, STATES.REJECTED)) {
      return res.status(409).json({ error: `cannot reject from state ${post.state}` });
    }
    await store.updatePost(post.id, { state: STATES.REJECTED });
    res.json({ ok: true });
  });

  app.get('/api/status', requireAuth, async (req, res) => {
    const recent = (await store.listPosts({ limit: 30 })).map((p) => publicPost(p));
    const manual = await store.listHumanPosts({ status: 'pending', limit: 50 });
    res.json({ recent, manual });
  });

  app.post('/api/human/:id/posted', requireAuth, async (req, res) => {
    const row = await store.markHumanPosted(req.params.id);
    res.json({ ok: true, row });
  });

  // ── Auto-scheduler ───────────────────────────────────────────────────────────
  app.post('/api/schedule/preview', requireAuth, async (req, res) => {
    try {
      const { startDate, brandFilter } = req.body || {};
      const summary = await scheduler.generateAndScheduleBatch({ startDate, brandFilter, dryRun: true, deps });
      res.json(summary);
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  app.post('/api/schedule/run', requireAuth, async (req, res) => {
    try {
      const { startDate, brandFilter } = req.body || {};
      const summary = await scheduler.generateAndScheduleBatch({ startDate, brandFilter, dryRun: false, deps });
      res.json(summary);
    } catch (e) {
      res.status(e.statusCode || 500).json({ error: e.message });
    }
  });

  // ── Metrics ──────────────────────────────────────────────────────────────────
  app.post('/api/metrics/fetch', requireAuth, async (req, res) => {
    try {
      const result = await fetchAndStoreMetrics({ store, client: bufferClient });
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/metrics', requireAuth, async (req, res) => {
    const metrics = await store.listAllPostMetrics();
    res.json({ metrics });
  });

  // ── HeyGen ──────────────────────────────────────────────────────────────────
  // Returns configured avatar/voice IDs for the console form (never the API key).
  app.get('/api/heygen/config', requireAuth, (req, res) => {
    res.json({
      avatarId: config.heygen.avatarId || '',
      voiceIdEn: config.heygen.voiceIdEn || '',
      voiceIdEs: config.heygen.voiceIdEs || '',
    });
  });

  // Manually fire a HeyGen video generation.
  app.post('/api/heygen/generate', requireAuth, async (req, res) => {
    const { brand, script, brief, avatarId, voiceId, language, aspectRatio } = req.body || {};
    if (!isBrand(brand)) return res.status(400).json({ error: 'invalid brand' });
    if (!String(script || '').trim()) return res.status(400).json({ error: 'script is required' });
    if (!avatarId) return res.status(400).json({ error: 'avatar_id is required' });
    if (!voiceId) return res.status(400).json({ error: 'voice_id is required' });

    try {
      const scriptText = String(script).trim();
      const data = await heygenClient.createVideo({
        avatarId,
        voiceId,
        script: scriptText,
        aspectRatio: aspectRatio || '9:16',
      });
      const job = await store.createHeygenJob({
        heygen_video_id: data.video_id,
        brand,
        brief: brief || scriptText.slice(0, 120),
        avatar_id: avatarId,
        voice_id: voiceId,
        language: language || 'en',
        script: scriptText,
        aspect_ratio: aspectRatio || '9:16',
      });
      heygenPollJob(job.id, deps).catch((e) => logger.error(`HeyGen poll ${job.id}: ${e.message}`));
      res.status(201).json({ job_id: job.id, heygen_video_id: data.video_id, status: 'rendering' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/heygen/jobs', requireAuth, async (req, res) => {
    const jobs = await store.listHeygenJobs({ limit: 50 });
    res.json({ jobs });
  });

  app.get('/api/heygen/jobs/:id', requireAuth, async (req, res) => {
    const job = await store.getHeygenJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'not found' });
    res.json(job);
  });

  // Proxy HeyGen avatar list so the console can look up IDs without exposing the key.
  app.get('/api/heygen/avatars', requireAuth, async (req, res) => {
    try {
      const key = config.heygen && config.heygen.apiKey;
      if (!key) return res.status(503).json({ error: 'HEYGEN_API_KEY not configured' });
      const r = await fetch('https://api.heygen.com/v2/avatars', { headers: { 'X-Api-Key': key } });
      const body = await r.json();
      res.json(body);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Resolve a live link for a published post (best-effort; Buffer hosts the post).
  function publicPost(p) {
    return {
      id: p.id,
      brand: p.brand,
      destination: p.destination,
      state: p.state,
      brief: p.brief,
      copy: p.copy,
      image_url: p.image_path ? (/^https?:\/\//i.test(p.image_path) ? p.image_path : `${config.publicBaseUrl}/${p.image_path}`) : null,
      intended_post_time: p.intended_post_time,
      auto_publish: p.auto_publish,
      channel_ids: p.channel_ids,
      buffer_post_ids: p.buffer_post_ids,
      error: p.error,
      media_type: p.media_type || null,
      detected_ratio: p.detected_ratio || null,
      eligible_destinations: p.eligible_destinations || [],
      source: p.source || null,
      created_at: p.created_at,
      updated_at: p.updated_at,
    };
  }

  app.locals.deps = deps;
  return app;
}

// ── Boot ─────────────────────────────────────────────────────────────────────
async function buildDeps() {
  // createStore() selects Postgres when DATABASE_URL is set, else SQLite — no
  // call-site branching here.
  const store = await createStore();
  const drafter = createDrafter();
  const publisher = new BufferPublisher({ store });
  return { store, drafter, publisher };
}

async function start() {
  const { fatal, warnings } = validate();
  fatal.forEach((m) => logger.error(`[startup] ${m}`));
  if (fatal.length) process.exit(1);
  warnings.forEach((m) => logger.warn(`[startup] ${m}`));

  const deps = await buildDeps();
  const app = createApp(deps);
  const workerHandle = worker.startWorker(deps, { intervalMs: 1500 });
  deps.nudge = workerHandle.nudge; // route nudge() through the running-flag tick
  const metricsInterval = setInterval(async () => {
    try { await fetchAndStoreMetrics({ store: deps.store, client: bufferClient }); }
    catch (e) { logger.error(`Background metrics fetch failed: ${e.message}`); }
  }, 60 * 60 * 1000);
  if (metricsInterval.unref) metricsInterval.unref();
  heygenResume(deps).catch((e) => logger.error(`HeyGen resume error: ${e.message}`));
  app.listen(config.port, () => {
    logger.info(`social-posting-service listening on :${config.port} (public: ${config.publicBaseUrl})`);
  });
}

if (require.main === module) {
  start().catch((e) => {
    logger.error(`Fatal startup error: ${e.message}`);
    process.exit(1);
  });
}

module.exports = { createApp, buildDeps, checkPassword };
