'use strict';

// Backward-compatible facade. The store implementations live in src/store/.
// `createStore()` is async (returns a ready Store) and selects SQLite or Postgres
// by env — see src/store/index.js and src/store/Store.js for the interface.
module.exports = require('./store');
