'use strict';

const { nowIso, newId, rowToPost, postInsertValues, applyPostPatch, POST_COLUMNS, scheduledInsertValues, SCHEDULED_COLUMNS, SCHEDULED_UPDATABLE } = require('./mappers');

// Postgres implementation of the Store interface. Works against ANY object that
// exposes an async `query(text, params) -> { rows }` — a `pg.Pool` in production,
// or an in-process PGlite instance in tests. Same columns/states/JSON-as-TEXT
// shape as SqliteStore, so the two are interchangeable.

const DDL = [
  `CREATE TABLE IF NOT EXISTS social_posts (
    id TEXT PRIMARY KEY, brand TEXT NOT NULL, destination TEXT NOT NULL DEFAULT 'buffer',
    brief TEXT NOT NULL, copy TEXT, image_path TEXT, image_alt TEXT, intended_post_time TEXT,
    auto_publish INTEGER NOT NULL DEFAULT 0, ai_draft INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'drafted',
    channel_ids TEXT NOT NULL DEFAULT '[]', buffer_post_ids TEXT NOT NULL DEFAULT '{}',
    scheduling_mode TEXT, attempts INTEGER NOT NULL DEFAULT 0, error TEXT, calendar_key TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  // Idempotent column adds for the already-created production table.
  `ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS ai_draft INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS calendar_key TEXT`,
  `ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS media_type TEXT`,
  `ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS detected_ratio TEXT`,
  `ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS eligible_destinations TEXT NOT NULL DEFAULT '[]'`,
  `CREATE INDEX IF NOT EXISTS idx_social_posts_state ON social_posts(state)`,
  `CREATE INDEX IF NOT EXISTS idx_social_posts_calkey ON social_posts(calendar_key)`,
  `CREATE TABLE IF NOT EXISTS human_post_queue (
    id TEXT PRIMARY KEY, source_post_id TEXT, brand TEXT NOT NULL, platform TEXT NOT NULL,
    copy TEXT, image_path TEXT, error TEXT, status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_hpq_status ON human_post_queue(status)`,
  `CREATE TABLE IF NOT EXISTS channels (
    brand TEXT NOT NULL, channel_id TEXT NOT NULL, service TEXT, name TEXT, display_name TEXT,
    created_at TEXT NOT NULL, PRIMARY KEY (brand, channel_id)
  )`,
  `CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)`,
  `CREATE TABLE IF NOT EXISTS buffer_submits (
    post_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    buffer_post_id TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (post_id, channel_id)
  )`,
  `CREATE TABLE IF NOT EXISTS scheduled_posts (
    id TEXT PRIMARY KEY, brand TEXT NOT NULL, channel TEXT NOT NULL, metro TEXT,
    due_at TEXT NOT NULL, text TEXT, image_url TEXT, status TEXT NOT NULL DEFAULT 'planned',
    buffer_post_id TEXT, calendar_key TEXT, error TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_scheduled_status ON scheduled_posts(status)`,
  `CREATE INDEX IF NOT EXISTS idx_scheduled_key ON scheduled_posts(calendar_key)`,
];

function placeholders(n, start = 1) {
  return Array.from({ length: n }, (_, i) => `$${i + start}`).join(', ');
}

class PgStore {
  // `pool` is anything with async query(text, params) -> { rows }.
  constructor(pool) {
    this.pool = pool;
    this.dialect = 'postgres';
  }

  async init() {
    for (const stmt of DDL) await this.pool.query(stmt);
    return this;
  }

  async _one(text, params) {
    const r = await this.pool.query(text, params);
    return r.rows && r.rows[0] ? r.rows[0] : null;
  }

  async createPost(input) {
    const row = postInsertValues(input, nowIso());
    const values = POST_COLUMNS.map((c) => row[c]);
    await this.pool.query(`INSERT INTO social_posts (${POST_COLUMNS.join(', ')}) VALUES (${placeholders(POST_COLUMNS.length)})`, values);
    return this.getPost(row.id);
  }

  async getPost(id) {
    return rowToPost(await this._one('SELECT * FROM social_posts WHERE id = $1', [id]));
  }

  // Idempotency for the scheduler: an existing non-terminal post for a calendar key.
  async findActivePostByCalendarKey(calendarKey) {
    return rowToPost(await this._one("SELECT * FROM social_posts WHERE calendar_key = $1 AND state IN ('awaiting_review','queued','posting','published') LIMIT 1", [calendarKey]));
  }

  async updatePost(id, patch) {
    const cur = await this._one('SELECT * FROM social_posts WHERE id = $1', [id]);
    if (!cur) throw new Error(`No social_post ${id}`);
    const next = applyPostPatch(cur, patch, nowIso());
    const cols = POST_COLUMNS.filter((c) => c !== 'id');
    const setClause = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
    const values = cols.map((c) => next[c]);
    values.push(id);
    await this.pool.query(`UPDATE social_posts SET ${setClause} WHERE id = $${values.length}`, values);
    return this.getPost(id);
  }

  async listPosts({ state, states, limit = 100 } = {}) {
    let rows;
    if (state) {
      ({ rows } = await this.pool.query('SELECT * FROM social_posts WHERE state = $1 ORDER BY created_at ASC LIMIT $2', [state, limit]));
    } else if (states && states.length) {
      const ph = placeholders(states.length);
      ({ rows } = await this.pool.query(`SELECT * FROM social_posts WHERE state IN (${ph}) ORDER BY created_at ASC LIMIT $${states.length + 1}`, [...states, limit]));
    } else {
      ({ rows } = await this.pool.query('SELECT * FROM social_posts ORDER BY created_at DESC LIMIT $1', [limit]));
    }
    return rows.map(rowToPost);
  }

  async addHumanPost(input) {
    const ts = nowIso();
    const row = {
      id: input.id || newId(),
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
    const cols = ['id', 'source_post_id', 'brand', 'platform', 'copy', 'image_path', 'error', 'status', 'created_at', 'updated_at'];
    await this.pool.query(`INSERT INTO human_post_queue (${cols.join(', ')}) VALUES (${placeholders(cols.length)})`, cols.map((c) => row[c]));
    return this._one('SELECT * FROM human_post_queue WHERE id = $1', [row.id]);
  }

  async listHumanPosts({ status, limit = 100 } = {}) {
    if (status) {
      const { rows } = await this.pool.query('SELECT * FROM human_post_queue WHERE status = $1 ORDER BY created_at DESC LIMIT $2', [status, limit]);
      return rows;
    }
    const { rows } = await this.pool.query('SELECT * FROM human_post_queue ORDER BY created_at DESC LIMIT $1', [limit]);
    return rows;
  }

  async markHumanPosted(id) {
    await this.pool.query('UPDATE human_post_queue SET status = $1, updated_at = $2 WHERE id = $3', ['posted', nowIso(), id]);
    return this._one('SELECT * FROM human_post_queue WHERE id = $1', [id]);
  }

  // Idempotent: clear the brand's channels then upsert. Re-running never duplicates.
  async setChannels(brand, channels) {
    const b = String(brand).toLowerCase();
    const ts = nowIso();
    await this.pool.query('DELETE FROM channels WHERE brand = $1', [b]);
    for (const c of channels) {
      await this.pool.query(
        `INSERT INTO channels (brand, channel_id, service, name, display_name, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (brand, channel_id) DO UPDATE SET service = EXCLUDED.service, name = EXCLUDED.name, display_name = EXCLUDED.display_name`,
        [b, c.id || c.channel_id, c.service || null, c.name || null, c.displayName || c.display_name || null, ts]
      );
    }
    return this.resolveChannelsForBrand(b);
  }

  async resolveChannelsForBrand(brand) {
    const { rows } = await this.pool.query(
      'SELECT channel_id AS id, service, name, display_name AS "displayName" FROM channels WHERE brand = $1 ORDER BY service',
      [String(brand).toLowerCase()]
    );
    return rows;
  }

  async kvGet(k) {
    const row = await this._one('SELECT v FROM kv WHERE k = $1', [k]);
    return row ? row.v : null;
  }
  async kvSet(k, v) {
    await this.pool.query('INSERT INTO kv (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v', [k, v]);
  }

  // ── scheduled_posts ─────────────────────────────────────────────────────
  async createScheduledPost(input) {
    const row = scheduledInsertValues(input, nowIso());
    await this.pool.query(
      `INSERT INTO scheduled_posts (${SCHEDULED_COLUMNS.join(', ')}) VALUES (${placeholders(SCHEDULED_COLUMNS.length)})`,
      SCHEDULED_COLUMNS.map((c) => row[c])
    );
    return this.getScheduledPost(row.id);
  }

  async getScheduledPost(id) {
    return this._one('SELECT * FROM scheduled_posts WHERE id = $1', [id]);
  }

  async updateScheduledPost(id, patch) {
    const cols = Object.keys(patch).filter((k) => SCHEDULED_UPDATABLE.includes(k));
    const sets = cols.map((c, i) => `${c} = $${i + 1}`);
    const vals = cols.map((c) => patch[c]);
    sets.push(`updated_at = $${vals.length + 1}`);
    vals.push(nowIso());
    vals.push(id);
    await this.pool.query(`UPDATE scheduled_posts SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    return this.getScheduledPost(id);
  }

  async listScheduledPosts({ status, limit = 200 } = {}) {
    if (status) {
      const { rows } = await this.pool.query('SELECT * FROM scheduled_posts WHERE status = $1 ORDER BY due_at ASC LIMIT $2', [status, limit]);
      return rows;
    }
    const { rows } = await this.pool.query('SELECT * FROM scheduled_posts ORDER BY due_at DESC LIMIT $1', [limit]);
    return rows;
  }

  async findActiveScheduledByKey(calendarKey) {
    return this._one("SELECT * FROM scheduled_posts WHERE calendar_key = $1 AND status IN ('scheduled','sent') LIMIT 1", [calendarKey]);
  }

  // ── Atomic claim / approve ───────────────────────────────────────────────
  async claimPost(id) {
    const CLAIM_TIMEOUT_MS = 2 * 60 * 1000;
    const staleThreshold = new Date(Date.now() - CLAIM_TIMEOUT_MS).toISOString();
    const row = await this._one(
      "UPDATE social_posts SET state='posting', attempts=attempts+1, updated_at=$1 WHERE id=$2 AND (state='queued' OR (state='posting' AND updated_at < $3)) RETURNING *",
      [nowIso(), id, staleThreshold]
    );
    if (!row) return null;
    await this.pool.query('DELETE FROM buffer_submits WHERE post_id=$1 AND buffer_post_id IS NULL', [id]);
    return rowToPost(row);
  }

  async approvePost(id) {
    const row = await this._one(
      "UPDATE social_posts SET state='queued', updated_at=$1 WHERE id=$2 AND state='awaiting_review' RETURNING *",
      [nowIso(), id]
    );
    return row ? rowToPost(row) : null;
  }

  // ── buffer_submits dedup helpers ─────────────────────────────────────────
  async insertBufferSubmit(postId, channelId) {
    const r = await this.pool.query(
      'INSERT INTO buffer_submits (post_id, channel_id, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING post_id',
      [postId, channelId, nowIso()]
    );
    return r.rows.length > 0;
  }

  async getBufferSubmit(postId, channelId) {
    return this._one('SELECT * FROM buffer_submits WHERE post_id=$1 AND channel_id=$2', [postId, channelId]);
  }

  async recordBufferSubmit(postId, channelId, bufferPostId) {
    await this.pool.query('UPDATE buffer_submits SET buffer_post_id=$1 WHERE post_id=$2 AND channel_id=$3', [bufferPostId, postId, channelId]);
  }

  async close() {
    if (this.pool && typeof this.pool.end === 'function') await this.pool.end();
    if (this.pool && typeof this.pool.close === 'function') await this.pool.close();
  }
}

module.exports = { PgStore };
