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
    logger.info('Datastore: Postgres (DATABASE_URL present)');
    return new PgStore(pool).init();
  }

  const sqlitePath = opts.sqlitePath || config.datastore.sqlitePath;
  logger.info(`Datastore: SQLite (${sqlitePath})`);
  return new SqliteStore(sqlitePath).init();
}

module.exports = { createStore, newId: mappers.newId, nowIso: mappers.nowIso, SqliteStore, PgStore };
