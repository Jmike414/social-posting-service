'use strict';

// Parity suite: the SAME assertions run against BOTH store implementations in a
// single pass — SqliteStore and PgStore (over an in-process PGlite, real Postgres
// semantics). This is what guarantees they are interchangeable behind createStore.

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeSqliteStore, makePgStore } = require('./helpers');

// The "pg" arm is a REAL node-postgres pg.Pool when DATABASE_URL is set, else an
// in-process PGlite — both via makePgStore(). The label reflects which.
const PG_LABEL = process.env.DATABASE_URL ? 'pg(real)' : 'pg(pglite)';
const IMPLS = [
  ['sqlite', makeSqliteStore],
  [PG_LABEL, makePgStore],
];

for (const [name, make] of IMPLS) {
  test(`[${name}] social_posts: create/read with JSON + boolean round-trip`, async () => {
    const store = await make();
    const created = await store.createPost({
      brand: 'PropZombie', brief: 'b', copy: 'hi', auto_publish: true,
      channel_ids: ['a', 'b'], buffer_post_ids: { a: 'p1' }, intended_post_time: '2026-07-01T15:00:00.000Z',
    });
    const got = await store.getPost(created.id);
    assert.equal(got.brand, 'propzombie');
    assert.equal(got.auto_publish, true);
    assert.deepEqual(got.channel_ids, ['a', 'b']);
    assert.deepEqual(got.buffer_post_ids, { a: 'p1' });
    assert.equal(got.attempts, 0);
    await store.close();
  });

  test(`[${name}] social_posts: update merges patch + lists by state/states`, async () => {
    const store = await make();
    const p = await store.createPost({ brand: 'propzombie', brief: 'b', state: 'drafted' });
    await store.updatePost(p.id, { state: 'queued', buffer_post_ids: { c1: 'x' }, attempts: 2 });
    const got = await store.getPost(p.id);
    assert.equal(got.state, 'queued');
    assert.deepEqual(got.buffer_post_ids, { c1: 'x' });
    assert.equal(got.attempts, 2);

    await store.createPost({ brand: 'propzombie', brief: 'b2', state: 'awaiting_review' });
    assert.equal((await store.listPosts({ state: 'queued' })).length, 1);
    assert.equal((await store.listPosts({ states: ['queued', 'awaiting_review'] })).length, 2);
    await store.close();
  });

  test(`[${name}] human_post_queue: add/list/mark posted`, async () => {
    const store = await make();
    const row = await store.addHumanPost({ brand: 'crewmando', platform: 'fb_group', copy: 'post me', error: 'boom' });
    let pending = await store.listHumanPosts({ status: 'pending' });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].platform, 'fb_group');
    await store.markHumanPosted(row.id);
    assert.equal((await store.listHumanPosts({ status: 'pending' })).length, 0);
    await store.close();
  });

  test(`[${name}] setChannels is IDEMPOTENT on re-run (no duplicate rows)`, async () => {
    const store = await make();
    const channels = [
      { id: 'fb_1', service: 'facebook', name: 'Page', displayName: 'PZ Page' },
      { id: 'ig_1', service: 'instagram', name: 'IG', displayName: 'PZ IG' },
    ];
    await store.setChannels('propzombie', channels);
    await store.setChannels('propzombie', channels); // re-run (redeploy / repeat)
    const resolved = await store.resolveChannelsForBrand('propzombie');
    assert.equal(resolved.length, 2, 're-running setup must not duplicate channels');
    assert.deepEqual(resolved.map((c) => c.id).sort(), ['fb_1', 'ig_1']);
    assert.equal(resolved.find((c) => c.id === 'fb_1').displayName, 'PZ Page');

    // Replacing with a smaller set removes the stale channel.
    await store.setChannels('propzombie', [{ id: 'fb_1', service: 'facebook' }]);
    assert.equal((await store.resolveChannelsForBrand('propzombie')).length, 1);
    await store.close();
  });

  test(`[${name}] kv upsert`, async () => {
    const store = await make();
    assert.equal(await store.kvGet('organization_id'), null);
    await store.kvSet('organization_id', 'org_1');
    await store.kvSet('organization_id', 'org_2'); // upsert, not duplicate
    assert.equal(await store.kvGet('organization_id'), 'org_2');
    await store.close();
  });
}
