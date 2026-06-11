'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { nowIso, rowToPost, postInsertValues, applyPostPatch, POST_COLUMNS } = require('./mappers');

// SQLite implementation of the Store interface (see store/index.js for the
// contract). better-sqlite3 is synchronous; methods are declared `async` so the
// interface is identical to PgStore and call sites await uniformly.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS social_posts (
  id TEXT PRIMARY KEY, brand TEXT NOT NULL, destination TEXT NOT NULL DEFAULT 'buffer',
  brief TEXT NOT NULL, copy TEXT, image_path TEXT, image_alt TEXT, intended_post_time TEXT,
  auto_publish INTEGER NOT NULL DEFAULT 0, ai_draft INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'drafted',
  channel_ids TEXT NOT NULL DEFAULT '[]', buffer_post_ids TEXT NOT NULL DEFAULT '{}',
  scheduling_mode TEXT, attempts INTEGER NOT NULL DEFAULT 0, error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_social_posts_state ON social_posts(state);
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

  async close() {
    this.db.close();
  }
}

module.exports = { SqliteStore };
