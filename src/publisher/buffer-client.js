'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// THE Buffer adapter. Every Buffer-specific GraphQL string, every input shape,
// and the transport live in THIS FILE ONLY. If Buffer shifts its beta schema,
// the blast radius is this module.
//
// Schema verified against Buffer's live reference docs (developers.buffer.com),
// per-type pages. Endpoint: POST https://api.buffer.com  with
// `Authorization: Bearer <BUFFER_API_KEY>`.
//
//   createPost(input: CreatePostInput!): PostActionPayload!
//     CreatePostInput (required): channelId, schedulingType, assets, mode
//       schedulingType: automatic
//       mode: addToQueue | customScheduled (needs dueAt) | shareNow | shareNext
//       assets: [AssetInput!]!   (pass [] for text-only)
//     PostActionPayload = PostActionSuccess { post {...} } | MutationError { message }
//   AssetInput @oneOf { image | video | document | link }
//     ImageAssetInput { url: String!, thumbnailUrl: String, metadata: ImageMetadataInput }
//     ImageMetadataInput { altText: String!, ... }
//   channels(input: ChannelsInput!) -> [Channel]  (ChannelsInput.organizationId)
//   posts(input: PostsInput!) -> { edges { node {...} } }  (idempotency lookup)
//   post(input: PostInput!) -> Post   (status check)
// ─────────────────────────────────────────────────────────────────────────────

const { config } = require('../config');
const { logger } = require('../logger');

class BufferError extends Error {
  constructor(message, { code, status, retryAfter, graphqlErrors, raw } = {}) {
    super(message);
    this.name = 'BufferError';
    this.code = code || 'BUFFER_ERROR'; // RATE_LIMIT | SERVER_ERROR | CLIENT_ERROR | GRAPHQL_ERROR | CONFIG
    this.status = status;
    this.retryAfter = retryAfter; // seconds, when known
    this.graphqlErrors = graphqlErrors;
    this.raw = raw;
  }

  // Retryable = transient: 5xx or rate-limit. Everything else is a hard failure.
  get retryable() {
    return this.code === 'SERVER_ERROR' || this.code === 'RATE_LIMIT';
  }
}

function bufferEnabled() {
  return !!config.buffer.apiKey;
}

function parseRateLimit(headers) {
  if (!headers || typeof headers.get !== 'function') return null;
  const limit = headers.get('ratelimit-limit');
  const remaining = headers.get('ratelimit-remaining');
  const reset = headers.get('ratelimit-reset');
  if (limit == null && remaining == null && reset == null) return null;
  return {
    limit: limit != null ? Number(limit) : null,
    remaining: remaining != null ? Number(remaining) : null,
    reset: reset || null,
  };
}

// Low-level GraphQL transport. Returns parsed `data` and the observed rate-limit
// snapshot; throws a typed BufferError on any failure (with the raw payload
// preserved verbatim — beta API, we want the unmodified errors).
async function gql(query, variables = {}, { fetchImpl = fetch, signal } = {}) {
  if (!bufferEnabled()) {
    throw new BufferError('BUFFER_API_KEY not set', { code: 'CONFIG' });
  }

  let res;
  try {
    res = await fetchImpl(config.buffer.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.buffer.apiKey}`,
      },
      body: JSON.stringify({ query, variables }),
      signal,
    });
  } catch (err) {
    // Network-level failure — treat as transient/server error so it retries.
    throw new BufferError(`Network error calling Buffer: ${err.message}`, { code: 'SERVER_ERROR', raw: String(err) });
  }

  const rateLimit = parseRateLimit(res.headers);
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { parseError: true, rawText: text };
  }

  if (res.status === 429) {
    const retryAfter = extractRetryAfter(body, res.headers);
    throw new BufferError('Buffer rate limit exceeded (429)', {
      code: 'RATE_LIMIT',
      status: 429,
      retryAfter,
      raw: body,
    });
  }
  if (res.status >= 500) {
    throw new BufferError(`Buffer server error (${res.status})`, { code: 'SERVER_ERROR', status: res.status, raw: body });
  }
  if (res.status >= 400) {
    throw new BufferError(`Buffer client error (${res.status})`, { code: 'CLIENT_ERROR', status: res.status, raw: body });
  }

  if (body && Array.isArray(body.errors) && body.errors.length) {
    // A GraphQL-level error. Some rate-limit conditions surface here with an
    // extensions.code rather than a 429 — detect and reclassify as retryable.
    const rateLimited = body.errors.some((e) => e && e.extensions && e.extensions.code === 'RATE_LIMIT_EXCEEDED');
    logger.error('Buffer GraphQL errors (verbatim):', JSON.stringify(body.errors));
    throw new BufferError(rateLimited ? 'Buffer rate limit exceeded' : 'Buffer GraphQL error', {
      code: rateLimited ? 'RATE_LIMIT' : 'GRAPHQL_ERROR',
      status: res.status,
      retryAfter: rateLimited ? extractRetryAfter(body, res.headers) : undefined,
      graphqlErrors: body.errors,
      raw: body,
    });
  }

  return { data: body.data, rateLimit };
}

function extractRetryAfter(body, headers) {
  // Prefer the GraphQL extensions.retryAfter, fall back to the Retry-After header.
  if (body && Array.isArray(body.errors)) {
    for (const e of body.errors) {
      const ra = e && e.extensions && (e.extensions.retryAfter ?? e.extensions.retry_after);
      if (ra != null) return Number(ra);
    }
  }
  if (headers && typeof headers.get === 'function') {
    const h = headers.get('retry-after');
    if (h != null) return Number(h);
  }
  return undefined;
}

// ── Input builders (Buffer-shaped) ───────────────────────────────────────────

// New (post-2026-05-25) assets format. @oneOf: exactly the `image` variant.
function buildImageAsset({ url, thumbnailUrl, altText } = {}) {
  if (!url) throw new BufferError('image asset requires a url', { code: 'CLIENT_ERROR' });
  const image = { url };
  if (thumbnailUrl) image.thumbnailUrl = thumbnailUrl;
  if (altText) image.metadata = { altText }; // ImageAssetInput.metadata: ImageMetadataInput (single object, per live SDL 2026-06-11)
  return { image };
}

// Builds a complete CreatePostInput. `assets` is required non-null in the schema,
// so text-only posts get an empty array.
function buildCreatePostInput({ channelId, text, mode, dueAt, assets } = {}) {
  if (!channelId) throw new BufferError('createPost requires channelId', { code: 'CLIENT_ERROR' });
  const input = {
    channelId,
    schedulingType: 'automatic',
    mode: mode || 'addToQueue',
    assets: Array.isArray(assets) ? assets : [],
  };
  if (text != null) input.text = text;
  if (dueAt) input.dueAt = dueAt; // ISO 8601 UTC, required for customScheduled
  return input;
}

const CREATE_POST_MUTATION = `
mutation CreatePost($input: CreatePostInput!) {
  createPost(input: $input) {
    __typename
    ... on PostActionSuccess {
      post { id text dueAt status assets { id mimeType } }
    }
    ... on MutationError { message }
  }
}`;

// Submits one post. Returns { ok, post } on success, or throws BufferError.
// A MutationError (validation) is a hard, non-retryable failure.
async function createPost(input, opts = {}) {
  const { data } = await gql(CREATE_POST_MUTATION, { input }, opts);
  const payload = data && data.createPost;
  if (!payload) throw new BufferError('createPost returned no payload', { code: 'GRAPHQL_ERROR', raw: data });
  if (payload.__typename === 'PostActionSuccess') {
    return { ok: true, post: payload.post };
  }
  // MutationError
  throw new BufferError(`Buffer rejected post: ${payload.message}`, {
    code: 'GRAPHQL_ERROR',
    raw: payload,
  });
}

const ORGS_QUERY = `query Organizations { account { organizations { id name } } }`;

async function getOrganizations(opts = {}) {
  const { data } = await gql(ORGS_QUERY, {}, opts);
  return (data && data.account && data.account.organizations) || [];
}

// Resolve an organization id: explicit config wins, else first org on the account.
async function resolveOrganizationId(opts = {}) {
  if (config.buffer.organizationId) return config.buffer.organizationId;
  const orgs = await getOrganizations(opts);
  if (!orgs.length) throw new BufferError('No Buffer organizations found on this account', { code: 'GRAPHQL_ERROR' });
  return orgs[0].id;
}

const CHANNELS_QUERY = `
query GetChannels($input: ChannelsInput!) {
  channels(input: $input) {
    id
    name
    displayName
    service
    type
    isDisconnected
  }
}`;

async function getChannels(organizationId, opts = {}) {
  const { data } = await gql(CHANNELS_QUERY, { input: { organizationId } }, opts);
  return (data && data.channels) || [];
}

const POSTS_QUERY = `
query GetPosts($input: PostsInput!) {
  posts(input: $input) {
    edges { node { id text status dueAt channelId createdAt } }
  }
}`;

// Idempotency-recovery lookup: list recent posts for a channel and return one
// whose text matches exactly. Used after a crash to detect an already-submitted
// post before resubmitting (avoids double-posting).
async function findPostByText({ organizationId, channelId, text }, opts = {}) {
  const input = {
    organizationId,
    sort: [{ field: 'createdAt', direction: 'desc' }],
    filter: { channelIds: [channelId] },
  };
  const { data } = await gql(POSTS_QUERY, { input }, opts);
  const edges = (data && data.posts && data.posts.edges) || [];
  const match = edges.find((e) => e && e.node && e.node.text === text);
  return match ? match.node : null;
}

const POST_QUERY = `
query GetPost($input: PostInput!) {
  post(input: $input) { id text status dueAt channelId }
}`;

async function getPost(id, opts = {}) {
  const { data } = await gql(POST_QUERY, { input: { id } }, opts);
  return (data && data.post) || null;
}

// Standard GraphQL introspection — used by scripts/introspect.js to dump the live
// schema SDL and prove zero-guessing against the running beta API.
const INTROSPECTION_QUERY = `
query IntrospectionQuery {
  __schema {
    queryType { name }
    mutationType { name }
    types {
      kind name description
      fields(includeDeprecated: true) { name type { ...TypeRef } }
      inputFields { name type { ...TypeRef } }
      enumValues(includeDeprecated: true) { name }
    }
  }
}
fragment TypeRef on __Type {
  kind name ofType { kind name ofType { kind name ofType { kind name } } }
}`;

async function introspect(opts = {}) {
  const { data } = await gql(INTROSPECTION_QUERY, {}, opts);
  return data && data.__schema;
}

module.exports = {
  BufferError,
  bufferEnabled,
  gql,
  parseRateLimit,
  buildImageAsset,
  buildCreatePostInput,
  createPost,
  getOrganizations,
  resolveOrganizationId,
  getChannels,
  findPostByText,
  getPost,
  introspect,
  // exported for tests
  _internal: { CREATE_POST_MUTATION, extractRetryAfter },
};
