'use strict';

// End-to-end through the HTTP console surface (session auth + JSON API).
process.env.CONSOLE_PASSWORD = 'pw';
process.env.SESSION_SECRET = 'test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDrafter } = require('../src/drafter');
const { processOnce } = require('../src/worker');
const { createApp } = require('../src/server');
const { makeStore } = require('./helpers');

async function startApp() {
  const store = await makeStore();
  const drafter = createDrafter({ client: null });
  const publisher = { publish: async () => ({ allSubmitted: true, bufferPostIds: {} }) };
  const deps = { store, drafter, publisher };
  const app = createApp(deps);
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, deps, port: server.address().port }));
  });
}

// minimal cookie jar
async function jarFetch(jar, url, opts = {}) {
  opts.headers = opts.headers || {};
  if (jar.cookie) opts.headers.Cookie = jar.cookie;
  const r = await fetch(url, opts);
  const sc = r.headers.get('set-cookie');
  if (sc) jar.cookie = sc.split(';')[0];
  return r;
}

test('full console flow: login -> compose -> review -> edit -> reject', async () => {
  const { server, deps, port } = await startApp();
  const base = `http://127.0.0.1:${port}`;
  const jar = {};
  try {
    // login
    let r = await jarFetch(jar, `${base}/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'pw' }),
    });
    assert.equal(r.status, 200);
    assert.ok(jar.cookie, 'session cookie set');

    // compose (no channels mapped -> still drafts and lands in review)
    r = await jarFetch(jar, `${base}/api/compose`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brand: 'propzombie', brief: 'fresh wholesale deal in Tampa', destination: 'buffer', auto_publish: 'false' }),
    });
    assert.equal(r.status, 201);
    const { id } = await r.json();

    // worker drafts synchronously for the assertion (nudge is fire-and-forget)
    await processOnce(deps);

    // review list
    r = await jarFetch(jar, `${base}/api/posts?state=awaiting_review`);
    let { posts } = await r.json();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].id, id);
    assert.ok(posts[0].copy, 'drafter produced copy');

    // edit keeps it in awaiting_review
    r = await jarFetch(jar, `${base}/api/posts/${id}/edit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ copy: 'edited copy' }),
    });
    assert.equal(r.status, 200);
    assert.equal((await deps.store.getPost(id)).state, 'awaiting_review');
    assert.equal((await deps.store.getPost(id)).copy, 'edited copy');

    // reject -> terminal, never reaches Buffer
    r = await jarFetch(jar, `${base}/api/posts/${id}/reject`, { method: 'POST' });
    assert.equal(r.status, 200);
    assert.equal((await deps.store.getPost(id)).state, 'rejected');

    // reject is terminal: cannot approve afterwards
    r = await jarFetch(jar, `${base}/api/posts/${id}/approve`, { method: 'POST' });
    assert.equal(r.status, 409);
  } finally {
    server.close();
    await deps.store.close();
  }
});
