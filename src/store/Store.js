'use strict';

// The single storage interface. The worker, server, publisher and enqueue path
// depend ONLY on this contract — never on a concrete store. SqliteStore (local
// dev) and PgStore (production) both implement it. Every method is async so the
// two are interchangeable behind `createStore()` with no call-site changes.
//
// Contract (all async):
//   init()                                  -> this        (create tables if absent)
//   createPost(input)                       -> post
//   getPost(id)                             -> post | null
//   updatePost(id, patch)                   -> post        (merges patch, bumps updated_at)
//   listPosts({ state | states, limit })    -> post[]
//   addHumanPost(input)                     -> humanRow
//   listHumanPosts({ status, limit })       -> humanRow[]
//   markHumanPosted(id)                     -> humanRow
//   setChannels(brand, channels)            -> channel[]   (idempotent replace; no dupes)
//   resolveChannelsForBrand(brand)          -> channel[]   ({ id, service, name, displayName })
//   kvGet(k)                                -> string|null
//   kvSet(k, v)                             -> void
//   close()                                 -> void
//
// A `post` has the shape produced by mappers.rowToPost: JSON fields parsed
// (channel_ids[], buffer_post_ids{}), auto_publish boolean, attempts number.

class Store {
  async init() { throw new Error('not implemented'); }
}

module.exports = { Store };
