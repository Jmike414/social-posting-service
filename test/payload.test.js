'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildCreatePostInput, buildImageAsset, buildPostMetadata, BufferError } = require('../src/publisher/buffer-client');

test('text post: assets is an empty array (required non-null), default addToQueue', () => {
  const input = buildCreatePostInput({ channelId: 'c1', text: 'hello' });
  assert.equal(input.channelId, 'c1');
  assert.equal(input.text, 'hello');
  assert.equal(input.schedulingType, 'automatic');
  assert.equal(input.mode, 'addToQueue');
  assert.deepEqual(input.assets, []);
  assert.equal('dueAt' in input, false);
});

test('scheduled post: customScheduled carries dueAt', () => {
  const input = buildCreatePostInput({ channelId: 'c1', text: 'hi', mode: 'customScheduled', dueAt: '2026-07-01T15:00:00.000Z' });
  assert.equal(input.mode, 'customScheduled');
  assert.equal(input.dueAt, '2026-07-01T15:00:00.000Z');
});

test('image asset uses the NEW format: image -> url + metadata[{altText}]', () => {
  const asset = buildImageAsset({ url: 'https://x/y.jpg', altText: 'a barn' });
  // @oneOf: exactly the image variant present
  assert.deepEqual(Object.keys(asset), ['image']);
  assert.equal(asset.image.url, 'https://x/y.jpg');
  assert.deepEqual(asset.image.metadata, { altText: 'a barn' });
  assert.equal('video' in asset, false);
});

test('image asset without altText omits metadata; thumbnailUrl passes through', () => {
  const asset = buildImageAsset({ url: 'https://x/y.jpg', thumbnailUrl: 'https://x/t.jpg' });
  assert.equal('metadata' in asset.image, false);
  assert.equal(asset.image.thumbnailUrl, 'https://x/t.jpg');
});

test('image post: assets array is embedded into CreatePostInput', () => {
  const assets = [buildImageAsset({ url: 'https://x/y.jpg', altText: 'alt' })];
  const input = buildCreatePostInput({ channelId: 'c1', text: 't', assets });
  assert.equal(input.assets.length, 1);
  assert.equal(input.assets[0].image.url, 'https://x/y.jpg');
});

test('missing channelId / image url throw BufferError', () => {
  assert.throws(() => buildCreatePostInput({ text: 'x' }), BufferError);
  assert.throws(() => buildImageAsset({ altText: 'x' }), BufferError);
});

test('Facebook posts carry the required post type metadata', () => {
  assert.deepEqual(buildPostMetadata('facebook'), { facebook: { type: 'post' } });
});

test('Instagram posts carry type + shouldShareToFeed metadata', () => {
  assert.deepEqual(buildPostMetadata('instagram'), { instagram: { type: 'post', shouldShareToFeed: true } });
});

test('unknown/absent service yields no metadata', () => {
  assert.equal(buildPostMetadata('twitter'), null);
  assert.equal(buildPostMetadata(undefined), null);
});

test('buildCreatePostInput embeds metadata when provided, omits it otherwise', () => {
  const withMeta = buildCreatePostInput({ channelId: 'c1', text: 'hi', metadata: buildPostMetadata('facebook') });
  assert.deepEqual(withMeta.metadata, { facebook: { type: 'post' } });
  const without = buildCreatePostInput({ channelId: 'c1', text: 'hi' });
  assert.equal('metadata' in without, false);
});
