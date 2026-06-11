'use strict';

// Configure the service surface before requiring it.
process.env.CONSOLE_PASSWORD = 'pw';
process.env.SERVICE_TOKEN = 'secret-token';
process.env.SESSION_SECRET = 'test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const { enqueue } = require('../src/enqueue');
const { createDrafter } = require('../src/drafter');
const { createApp } = require('../src/server');
const { STATES } = require('../src/state');
const { makeStore } = require('./helpers');

test('enqueue() validates brand', async () => {
  const store = await makeStore();
  await assert.rejects(() => enqueue(store, { brand: 'nope', brief: 'x' }), /Unknown brand/);
  await store.close();
});

test('enqueue() requires a brief', async () => {
  const store = await makeStore();
  await assert.rejects(() => enqueue(store, { brand: 'propzombie', brief: '   ' }), /brief is required/);
  await store.close();
});

test('enqueue() rejects invalid intended_post_time', async () => {
  const store = await makeStore();
  await assert.rejects(() => enqueue(store, { brand: 'propzombie', brief: 'x', intended_post_time: 'not-a-date' }), /not a valid date/);
  await store.close();
});

test('enqueue() creates a drafted row and normalizes the time to ISO', async () => {
  const store = await makeStore();
  const rec = await enqueue(store, { brand: 'PropZombie', brief: 'hello', intended_post_time: '2026-07-01T15:00:00Z', auto_publish: true });
  assert.equal(rec.state, STATES.DRAFTED);
  assert.equal(rec.brand, 'propzombie');
  assert.equal(rec.auto_publish, true);
  assert.equal(rec.intended_post_time, '2026-07-01T15:00:00.000Z');
  await store.close();
});

// ── HTTP enqueue endpoint (the engine's contract) ────────────────────────────
async function startApp() {
  const store = await makeStore();
  const drafter = createDrafter({ client: null });
  const publisher = { publish: async () => ({ allSubmitted: true, bufferPostIds: {} }) };
  const app = createApp({ store, drafter, publisher });
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, store, port: server.address().port }));
  });
}

test('POST /enqueue: valid token creates a drafted row', async () => {
  const { server, store, port } = await startApp();
  try {
    const r = await fetch(`http://127.0.0.1:${port}/enqueue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Token': 'secret-token' },
      body: JSON.stringify({ brand: 'propzombie', brief: 'from the engine' }),
    });
    assert.equal(r.status, 201);
    const body = await r.json();
    assert.ok(body.id);
    assert.equal(body.state, 'drafted');
    assert.equal((await store.getPost(body.id)).brief, 'from the engine');
  } finally {
    server.close();
    await store.close();
  }
});

test('POST /enqueue: wrong token is rejected 401', async () => {
  const { server, store, port } = await startApp();
  try {
    const r = await fetch(`http://127.0.0.1:${port}/enqueue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Token': 'wrong' },
      body: JSON.stringify({ brand: 'propzombie', brief: 'x' }),
    });
    assert.equal(r.status, 401);
  } finally {
    server.close();
    await store.close();
  }
});

test('console API requires auth', async () => {
  const { server, store, port } = await startApp();
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/status`);
    assert.equal(r.status, 401);
  } finally {
    server.close();
    await store.close();
  }
});
