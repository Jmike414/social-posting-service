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
const { STATES, canTransition } = require('./state');

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

  // Fire-and-forget worker nudge after a mutation, so the console feels instant.
  function nudge() {
    worker.processOnce(deps).catch((e) => logger.error(`nudge error: ${e.message}`));
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
    const post = await store.getPost(req.params.id);
    if (!post) return res.status(404).json({ error: 'not found' });
    if (!canTransition(post.state, STATES.QUEUED)) {
      return res.status(409).json({ error: `cannot approve from state ${post.state}` });
    }
    await store.updatePost(post.id, { state: STATES.QUEUED });
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
  worker.startWorker(deps, { intervalMs: 1500 });
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
