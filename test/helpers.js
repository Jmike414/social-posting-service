'use strict';

const crypto = require('crypto');
const { createStore } = require('../src/db');

// Test store factories.
//
//   Default (no env)        -> in-memory SQLite (isolated per call)
//   TEST_STORE=pg (no URL)  -> in-process PGlite (real Postgres semantics, isolated)
//   DATABASE_URL set        -> the REAL node-postgres pg.Pool driver against that
//                              server (the production path). Each store gets its own
//                              throwaway Postgres SCHEMA so the shared DB does not
//                              cross-contaminate count assertions across tests.
//
//   node --test                                         # SQLite
//   TEST_STORE=pg node --test                           # PGlite
//   DATABASE_URL=postgres://… TEST_STORE=pg node --test # REAL pg.Pool
//
// Real-pg isolation: a unique schema (t_<hex>) is created and the pool is opened
// with `search_path` pinned to it, so PgStore's unqualified CREATE TABLE / queries
// land in that schema. close() drops the schema and ends the pool.
async function makePgStore() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    const { PGlite } = require('@electric-sql/pglite');
    return createStore(new PGlite());
  }
  const { Pool } = require('pg');
  const schema = 't_' + crypto.randomBytes(6).toString('hex');
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 4 });
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  const store = await createStore(pool); // injected pool -> PgStore; init() builds tables in `schema`
  const origClose = store.close.bind(store);
  store.close = async () => {
    try { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } catch { /* throwaway */ }
    await origClose();
  };
  return store;
}

async function makeSqliteStore() {
  return createStore(':memory:');
}

// Env-driven default used by the behaviour suites.
async function makeStore() {
  if (process.env.DATABASE_URL || process.env.TEST_STORE === 'pg') {
    return makePgStore();
  }
  return makeSqliteStore();
}

module.exports = { makeStore, makePgStore, makeSqliteStore };
