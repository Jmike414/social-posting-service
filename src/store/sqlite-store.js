'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { nowIso, newId, rowToPost, postInsertValues, applyPostPatch, POST_COLUMNS, scheduledInsertValues, SCHEDULED_COLUMNS, SCHEDULED_UPDATABLE } = require('./mappers');

// SQLite implementation of the Store interface (see store/index.js for the
// contract). better-sqlite3 is synchronous; methods are declared `async` so the
// interface is identical to PgStore and call sites await uniformly.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS social_posts (
  id TEXT PRIMARY KEY, brand TEXT NOT NULL, destination TEXT NOT NULL DEFAULT 'buffer',
  brief TEXT NOT NULL, copy TEXT, image_path TEXT, image_alt TEXT, intended_post_time TEXT,
  auto_publish INTEGER NOT NULL DEFAULT 0, ai_draft INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'drafted',
  channel_ids TEXT NOT NULL DEFAULT '[]', buffer_post_ids TEXT NOT NULL DEFAULT '{}',
  scheduling_mode TEXT, attempts INTEGER NOT NULL DEFAULT 0, error TEXT, calendar_key TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_social_posts_state ON social_posts(state);
CREATE INDEX IF NOT EXISTS idx_social_posts_calkey ON social_posts(calendar_key);
CREATE TABLE IF NOT EXISTS human_post_queue (
  id TEXT PRIMARY KEY, source_post_id TEXT, brand TEXT NOT NULL, platform TEXT NOT NULL,
  copy TEXT, image_path TEXT, error TEXT, status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hpq_status ON human_post_queue(status);
CREATE TABLE IF NOT EXISTS channels (
  brand TEXT NOT NULL, channel_id TEXT NOT NULL, service TEXT, name TEXT, display_name TEXT,
  created_at TEXT NOT NULL, PRIMARY KEY (brand, channel_id)
);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS buffer_submits (
  post_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  buffer_post_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (post_id, channel_id)
);
CREATE TABLE IF NOT EXISTS scheduled_posts (
  id TEXT PRIMARY KEY, brand TEXT NOT NULL, channel TEXT NOT NULL, metro TEXT,
  due_at TEXT NOT NULL, text TEXT, image_url TEXT, status TEXT NOT NULL DEFAULT 'planned',
  buffer_post_id TEXT, calendar_key TEXT, error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_status ON scheduled_posts(status);
CREATE INDEX IF NOT EXISTS idx_scheduled_key ON scheduled_posts(calendar_key);
CREATE TABLE IF NOT EXISTS post_metrics (
  post_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  buffer_post_id TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  metrics_updated_at TEXT,
  metrics_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (post_id, channel_id)
);
`;

class SqliteStore {
  constructor(dbPathOrInstance) {
    if (dbPathOrInstance && typeof dbPathOrInstance.prepare === 'function') {
      this.db = dbPathOrInstance;
    } else {
      const dbPath = dbPathOrInstance || ':memory:';
      if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      this.db = new Database(dbPath);
    }
    this.dialect = 'sqlite';
  }

  async init() {
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
    // Idempotent column add for pre-existing local DBs (SQLite has no ADD COLUMN
    // IF NOT EXISTS; a duplicate-column error just means it's already there).
    try { this.db.exec('ALTER TABLE social_posts ADD COLUMN ai_draft INTEGER NOT NULL DEFAULT 0'); } catch { /* already exists */ }
    try { this.db.exec('ALTER TABLE social_posts ADD COLUMN calendar_key TEXT'); } catch { /* already exists */ }
    try { this.db.exec('ALTER TABLE social_posts ADD COLUMN media_type TEXT'); } catch { /* already exists */ }
    try { this.db.exec('ALTER TABLE social_posts ADD COLUMN detected_ratio TEXT'); } catch { /* already exists */ }
    try { this.db.exec("ALTER TABLE social_posts ADD COLUMN eligible_destinations TEXT NOT NULL DEFAULT '[]'"); } catch { /* already exists */ }
    return this;
  }

  async createPost(input) {
    const row = postInsertValues(input, nowIso());
    const cols = POST_COLUMNS.join(', ');
    const named = POST_COLUMNS.map((c) => `@${c}`).join(', ');
    this.db.prepare(`INSERT INTO social_posts (${cols}) VALUES (${named})`).run(row);
    return this.getPost(row.id);
  }

  async getPost(id) {
    return rowToPost(this.db.prepare('SELECT * FROM social_posts WHERE id = ?').get(id));
  }

  // Idempotency for the scheduler: an existing non-terminal post for a calendar key.
  async findActivePostByCalendarKey(calendarKey) {
    return rowToPost(this.db.prepare("SELECT * FROM social_posts WHERE calendar_key = ? AND state IN ('awaiting_review','queued','posting','published') LIMIT 1").get(calendarKey));
  }

  async updatePost(id, patch) {
    const cur = this.db.prepare('SELECT * FROM social_posts WHERE id = ?').get(id);
    if (!cur) throw new Error(`No social_post ${id}`);
    const next = applyPostPatch(cur, patch, nowIso());
    const setClause = POST_COLUMNS.filter((c) => c !== 'id').map((c) => `${c}=@${c}`).join(', ');
    this.db.prepare(`UPDATE social_posts SET ${setClause} WHERE id=@id`).run(next);
    return this.getPost(id);
  }

  async listPosts({ state, states, limit = 100 } = {}) {
    let rows;
    if (state) {
      rows = this.db.prepare('SELECT * FROM social_posts WHERE state = ? ORDER BY created_at ASC LIMIT ?').all(state, limit);
    } else if (states && states.length) {
      const ph = states.map(() => '?').join(',');
      rows = this.db.prepare(`SELECT * FROM social_posts WHERE state IN (${ph}) ORDER BY created_at ASC LIMIT ?`).all(...states, limit);
    } else {
      rows = this.db.prepare('SELECT * FROM social_posts ORDER BY created_at DESC LIMIT ?').all(limit);
    }
    return rows.map(rowToPost);
  }

  async addHumanPost(input) {
    const ts = nowIso();
    const row = {
      id: input.id || require('./mappers').newId(),
      source_post_id: input.source_post_id ?? null,
      brand: input.brand,
      platform: input.platform,
      copy: input.copy ?? null,
      image_path: input.image_path ?? null,
      error: input.error ?? null,
      status: input.status || 'pending',
      created_at: ts,
      updated_at: ts,
    };
    this.db.prepare(
      `INSERT INTO human_post_queue (id, source_post_id, brand, platform, copy, image_path, error, status, created_at, updated_at)
       VALUES (@id, @source_post_id, @brand, @platform, @copy, @image_path, @error, @status, @created_at, @updated_at)`
    ).run(row);
    return this.db.prepare('SELECT * FROM human_post_queue WHERE id = ?').get(row.id);
  }

  async listHumanPosts({ status, limit = 100 } = {}) {
    if (status) return this.db.prepare('SELECT * FROM human_post_queue WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit);
    return this.db.prepare('SELECT * FROM human_post_queue ORDER BY created_at DESC LIMIT ?').all(limit);
  }

  async markHumanPosted(id) {
    this.db.prepare('UPDATE human_post_queue SET status = ?, updated_at = ? WHERE id = ?').run('posted', nowIso(), id);
    return this.db.prepare('SELECT * FROM human_post_queue WHERE id = ?').get(id);
  }

  // Idempotent: replaces a brand's channel set so re-running setup never duplicates.
  async setChannels(brand, channels) {
    const b = String(brand).toLowerCase();
    const ts = nowIso();
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM channels WHERE brand = ?').run(b);
      const ins = this.db.prepare('INSERT INTO channels (brand, channel_id, service, name, display_name, created_at) VALUES (?, ?, ?, ?, ?, ?)');
      for (const c of channels) ins.run(b, c.id || c.channel_id, c.service || null, c.name || null, c.displayName || c.display_name || null, ts);
    });
    tx();
    return this.resolveChannelsForBrand(b);
  }

  async resolveChannelsForBrand(brand) {
    return this.db
      .prepare('SELECT channel_id AS id, service, name, display_name AS displayName FROM channels WHERE brand = ? ORDER BY service')
      .all(String(brand).toLowerCase());
  }

  async kvGet(k) {
    const row = this.db.prepare('SELECT v FROM kv WHERE k = ?').get(k);
    return row ? row.v : null;
  }
  async kvSet(k, v) {
    this.db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
  }

  // ── scheduled_posts ─────────────────────────────────────────────────────
  async createScheduledPost(input) {
    const row = scheduledInsertValues(input, nowIso());
    const named = SCHEDULED_COLUMNS.map((c) => `@${c}`).join(', ');
    this.db.prepare(`INSERT INTO scheduled_posts (${SCHEDULED_COLUMNS.join(', ')}) VALUES (${named})`).run(row);
    return this.getScheduledPost(row.id);
  }

  async getScheduledPost(id) {
    return this.db.prepare('SELECT * FROM scheduled_posts WHERE id = ?').get(id) || null;
  }

  async updateScheduledPost(id, patch) {
    const sets = [];
    const vals = { id, updated_at: nowIso() };
    for (const k of Object.keys(patch)) {
      if (SCHEDULED_UPDATABLE.includes(k)) { sets.push(`${k} = @${k}`); vals[k] = patch[k]; }
    }
    sets.push('updated_at = @updated_at');
    this.db.prepare(`UPDATE scheduled_posts SET ${sets.join(', ')} WHERE id = @id`).run(vals);
    return this.getScheduledPost(id);
  }

  async listScheduledPosts({ status, limit = 200 } = {}) {
    if (status) return this.db.prepare('SELECT * FROM scheduled_posts WHERE status = ? ORDER BY due_at ASC LIMIT ?').all(status, limit);
    return this.db.prepare('SELECT * FROM scheduled_posts ORDER BY due_at DESC LIMIT ?').all(limit);
  }

  // Idempotency: an active (awaiting_approval/sent) row for the same calendar key.
  async findActiveScheduledByKey(calendarKey) {
    return this.db.prepare("SELECT * FROM scheduled_posts WHERE calendar_key = ? AND status IN ('scheduled','sent') LIMIT 1").get(calendarKey) || null;
  }

  // ── Atomic claim / approve ───────────────────────────────────────────────
  // Returns the post in POSTING state (attempts incremented), or null if another
  // caller already claimed it (or the stale timeout hasn't elapsed for an
  // in-flight POSTING row). POSTING rows are re-claimable only after 2 minutes
  // (crash recovery window). Stale null buffer_submits are cleared on claim so
  // crash-recovery retries get a clean dedup slot.
  async claimPost(id) {
    const CLAIM_TIMEOUT_MS = 2 * 60 * 1000;
    const staleThreshold = new Date(Date.now() - CLAIM_TIMEOUT_MS).toISOString();
    const result = this.db.prepare(
      "UPDATE social_posts SET state='posting', attempts=attempts+1, updated_at=? WHERE id=? AND (state='queued' OR (state='posting' AND updated_at < ?))"
    ).run(nowIso(), id, staleThreshold);
    if (result.changes === 0) return null;
    this.db.prepare('DELETE FROM buffer_submits WHERE post_id=? AND buffer_post_id IS NULL').run(id);
    return this.getPost(id);
  }

  // Atomic approve: transitions awaiting_review → queued. Returns the updated post
  // or null if the post is not in awaiting_review (already approved, or not found).
  // A 409 response to the caller signals a duplicate tap or concurrent request.
  async approvePost(id) {
    const result = this.db.prepare(
      "UPDATE social_posts SET state='queued', updated_at=? WHERE id=? AND state='awaiting_review'"
    ).run(nowIso(), id);
    if (result.changes === 0) return null;
    return this.getPost(id);
  }

  // ── buffer_submits dedup helpers ─────────────────────────────────────────
  // INSERT the (post_id, channel_id) slot. Returns true if inserted (caller should
  // proceed to submit), false on conflict (another caller holds the slot).
  async insertBufferSubmit(postId, channelId) {
    try {
      this.db.prepare('INSERT INTO buffer_submits (post_id, channel_id, created_at) VALUES (?, ?, ?)').run(postId, channelId, nowIso());
      return true;
    } catch {
      return false; // UNIQUE constraint violation
    }
  }

  async getBufferSubmit(postId, channelId) {
    return this.db.prepare('SELECT * FROM buffer_submits WHERE post_id=? AND channel_id=?').get(postId, channelId) || null;
  }

  async recordBufferSubmit(postId, channelId, bufferPostId) {
    this.db.prepare('UPDATE buffer_submits SET buffer_post_id=? WHERE post_id=? AND channel_id=?').run(bufferPostId, postId, channelId);
  }

  async upsertPostMetrics({ postId, channelId, bufferPostId, fetchedAt, metricsUpdatedAt, metricsJson }) {
    this.db.prepare(
      `INSERT INTO post_metrics (post_id, channel_id, buffer_post_id, fetched_at, metrics_updated_at, metrics_json)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(post_id, channel_id) DO UPDATE SET
         buffer_post_id = excluded.buffer_post_id,
         fetched_at = excluded.fetched_at,
         metrics_updated_at = excluded.metrics_updated_at,
         metrics_json = excluded.metrics_json`
    ).run(postId, channelId, bufferPostId, fetchedAt, metricsUpdatedAt || null, metricsJson);
  }

  async getPostMetrics(postId) {
    return this.db.prepare('SELECT * FROM post_metrics WHERE post_id = ? ORDER BY channel_id').all(postId);
  }

  async listAllPostMetrics() {
    return this.db.prepare('SELECT * FROM post_metrics ORDER BY post_id, channel_id').all();
  }

  async close() {
    this.db.close();
  }
}

module.exports = { SqliteStore };
