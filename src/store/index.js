'use strict';

const { config } = require('../config');
const { logger } = require('../logger');
const { SqliteStore } = require('./sqlite-store');
const { PgStore } = require('./pg-store');
const mappers = require('./mappers');

// Store selection (the swap point). Resolution order:
//   1. an injected pg-compatible pool (has .query)  -> PgStore   (used by tests)
//   2. a string path / better-sqlite3 instance      -> SqliteStore
//   3. options/config: DATABASE_URL present          -> PgStore (real pg.Pool)
//   4. otherwise                                      -> SqliteStore (local dev)
//
// Returns a ready (init'd) store. Async because Postgres connect + schema init is.
async function createStore(arg) {
  // 1. Injected pool (pg.Pool or PGlite) — anything with async query()
  if (arg && typeof arg === 'object' && typeof arg.query === 'function') {
    return new PgStore(arg).init();
  }
  // 2. SQLite path string, ':memory:', or a better-sqlite3 instance
  if (typeof arg === 'string' || (arg && typeof arg.prepare === 'function')) {
    return new SqliteStore(arg).init();
  }

  const opts = arg || {};
  const databaseUrl = opts.databaseUrl || config.datastore.databaseUrl;
  if (databaseUrl) {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: databaseUrl, max: opts.max || 5 });
    // init() runs CREATE TABLE against Postgres — it only resolves on a live
    // connection, so logging AFTER it proves PgStore actually engaged (not merely
    // that DATABASE_URL was present).
    const store = await new PgStore(pool).init();
    let version = '';
    try {
      const r = await pool.query('select version()');
      version = ' - ' + String(r.rows[0].version).split(' (')[0];
    } catch { /* version probe is best-effort; engagement already proven by init() */ }
    logger.info(`Datastore engaged: Postgres (PgStore via pg.Pool)${version}`);
    return store;
  }

  const sqlitePath = opts.sqlitePath || config.datastore.sqlitePath;
  const store = await new SqliteStore(sqlitePath).init();
  logger.info(`Datastore engaged: SQLite (${sqlitePath})`);
  return store;
}

module.exports = { createStore, newId: mappers.newId, nowIso: mappers.nowIso, SqliteStore, PgStore };
