# Execution Report — social-posting-service

Date: 2026-06-10

## 0. Premise correction (Gate 0)

The original task framed this as *swapping* an existing Meta Graph API poster to
Buffer. Verification of the engine repo found **no poster module, no Meta/FB/IG
credentials, and no automated posting pipeline of any kind** — the only "drafter"
there produces DM/comment *replies* with a manual VA handoff. There was nothing
to swap. The work was therefore re-scoped (with the owner) to a **greenfield
standalone service**, which is what this directory contains.

## 1. What was built

A self-contained Node.js service (`social-posting-service/`, separate from the
engine) with three surfaces:

- **Drafter** — `src/drafter.js`. Anthropic (`claude-sonnet-4-6`) with a
  deterministic heuristic fallback when `ANTHROPIC_API_KEY` is absent.
- **Poster** — `SocialPublisher` interface + `BufferPublisher`, with **all** Buffer
  GraphQL isolated in `src/publisher/buffer-client.js`.
- **Mobile console** — `public/console.html` (+ `login.html`), served at `/`
  behind a session login: Compose / Review / Status.

Plus: a state-machine datastore (`src/db.js`, SQLite), a worker (`src/worker.js`),
the `enqueue()` contract (`src/enqueue.js`) and `POST /enqueue`, and two
operator scripts (`scripts/introspect.js`, `scripts/setup-channels.js`).

## 2. The Buffer schema, as actually verified

Verified against Buffer's **live reference docs** (developers.buffer.com), reading
the per-type pages (e.g. `/types/CreatePostInput.html`, `/types/ImageAssetInput.html`)
rather than guessing. The adapter is built to exactly this shape:

- **Endpoint:** `POST https://api.buffer.com` · `Authorization: Bearer <key>` ·
  `Content-Type: application/json`.
- **Org/channels:** `query { account { organizations { id name } } }`, then
  `channels(input: { organizationId }) { id name displayName service type isDisconnected }`.
- **Create:** `createPost(input: CreatePostInput!): PostActionPayload!` →
  `... on PostActionSuccess { post { id text dueAt status assets { id mimeType } } }`
  `... on MutationError { message }`.
  - **`CreatePostInput` required (non-null):** `channelId`, `schedulingType`
    (`automatic`), `assets: [AssetInput!]!`, `mode: ShareMode!`
    (`addToQueue` | `customScheduled` | `shareNow` | `shareNext`). Optional:
    `text`, `dueAt` (ISO 8601 UTC, used with `customScheduled`).
  - Text-only posts send `assets: []` (the field is non-null, so an empty array,
    not omission).
- **Image assets (post-2026-05-25 format):** `AssetInput` is `@oneOf` —
  `assets: [{ image: { url: String!, thumbnailUrl?, metadata: [{ altText: String! }] } }]`.
  `ImageAssetInput.metadata` is a **list** of `ImageMetadataInput`. The legacy
  `AssetsInput` object format is gone; this service never emits it.
- **Status / idempotency:** `post(input: { id })` → `status ∈ {draft, buffer, sent, failed}`;
  `posts(input: { organizationId, filter: { channelIds }, sort })` for the
  crash-recovery lookup.

> **Image posting needs a public URL.** Buffer fetches images by URL, so uploaded
> images are served by this service at `PUBLIC_BASE_URL/uploads/…`. On localhost
> Buffer cannot reach the image — image posts require a real public host
> (Render). Text posts have no such constraint.

## 3. Datastore choice

**SQLite** (`better-sqlite3`) — installs with a prebuilt binary on Node 25
Windows (verified, no compile). Tables: `social_posts`, `human_post_queue`,
`channels`, `kv`, all in this service's own DB file. **Postgres separate from the
engine** is the documented deploy target via `DATABASE_URL`.

## 4. Deviations from the spec (and why)

1. **Live introspection / real test posts are not yet run** — `BUFFER_API_KEY` is
   not present in this build environment (`BUFFER_API_KEY not set` confirmed).
   The adapter is verified against Buffer's published per-type schema reference
   (which mirrors introspection), and `npm run introspect` will dump the live SDL
   the moment the key is provided. The live channel-setup and real dashboard
   posts are **operator steps with the key** (commands in §6). This is the one
   open item against "Standard of done"; everything not gated on the key is done.
2. ~~**Postgres store not implemented, only documented.**~~ **RESOLVED** in the
   follow-up deploy task — `PgStore` is now implemented and tested. See the
   Addendum below.
3. **No `render.yaml`.** Kept the service platform-agnostic; deploy notes live in
   the README. Add one later if Render IaC is wanted.
4. **Published-post "live link"** surfaces the **Buffer post id(s)**, not a
   platform permalink — `createPost` returns the post id, not the public FB/IG
   URL (that exists only after Buffer publishes; fetchable later via post
   metrics). The id is the durable reference and the idempotency key.

## 5. Rate-limit headroom (our plan tier)

Per Buffer's documented windows:

| Plan | 15-min | 24-hr | 30-day |
|---|---|---|---|
| **Free** | 100 | 100 | 3,000 |
| Essentials | 100 | 250 | 7,500 |
| Team | 100 | 500 | 15,000 |

On **Free**, a 2-channel brand (FB Page + IG) costs ~2 `createPost` calls per
post, so ~50 posts/day fits inside the 100/24-hr window with margin — ample for a
marketing cadence. `429`/`RATE_LIMIT_EXCEEDED` is handled with backoff (honoring
`retryAfter`), and `RateLimit-Limit/Remaining/Reset` headers are parsed on every
response. **Live `RateLimit-Remaining` will be recorded on the first real call**
(pending key) — the transport already surfaces it.

## 6. Verification status

**Done (offline + local):**
- `npm test` → **32/32 passing**: payload + new assets format, GraphQL transport
  classification (429/5xx/GraphQL-error/rate-limit-in-extensions), idempotency
  (no resubmit when id stored; crash-recovery adoption), retry/backoff (succeeds
  within 3, gives up at 3, fast-fail on validation), brand→channel resolution,
  `auto_publish` branch, manual→human-queue routing, **failure→human_post_queue
  with verbatim error**, enqueue validation + `POST /enqueue` auth, and a full
  **login→compose→draft→edit→reject** console flow.
- **Reject path** exercised (terminal; never reaches Buffer) — `console-flow.test.js`.
- **Failure path** exercised (simulated 429 → `failed` + `human_post_queue` card
  with the verbatim `RATE_LIMIT_EXCEEDED` payload) — `worker.test.js`.
- **Live server boot**: `node src/server.js` serves `/health`, `/login`, redirects
  unauth `/`→`/login`, and an authenticated **compose→awaiting_review** round-trip
  works against the running server with the heuristic drafter.
- **No engine coupling**: no `require('../../…')` escapes the directory; the only
  occurrences of "engine"/`slice_source` are contract comments. All external
  requires are npm packages or Node builtins.

**Pending — requires `BUFFER_API_KEY` on the owner's account (operator runs):**
```bash
npm run introspect                 # dumps live schema → schema-introspection.json
npm run setup:channels propzombie  # persists real PropZombie FB Page + IG channel IDs
# then in the console (phone-width browser): Compose 1 text + 1 image PropZombie post,
# confirm drafter fills copy → Review → Approve → confirm both appear in the Buffer
# dashboard queue; paste the returned Buffer post IDs + dashboard state below.
```
- [ ] Live introspection SDL captured
- [ ] Channel map populated with real IDs (paste here)
- [ ] Text test post — Buffer id: ________  · dashboard state: ________
- [ ] Image test post — Buffer id: ________  · dashboard state: ________
- [ ] On-device mobile render confirmed (console is built mobile-first: viewport
      meta, ≤600px column, bottom tab bar, large touch targets, `capture` image
      input — confirm operable at phone width on the real device)

## 7. Files

```
src/config.js  logger.js  state.js  db.js  drafter.js  enqueue.js  worker.js  server.js
src/store/{Store,index,sqlite-store,pg-store,mappers}.js
src/publisher/{SocialPublisher,BufferPublisher,buffer-client}.js
public/{console,login}.html  manifest.webmanifest
scripts/{setup-channels,introspect}.js
render.yaml
test/{payload,buffer-transport,idempotency,retry,worker,enqueue,console-flow,store-contract}.test.js
```

---

# Addendum — Deploy Target (render.yaml + PgStore)

Date: 2026-06-10. **Storage + deploy only. No business, publisher, or state-machine
logic changed** — see "what changed" below.

## A. Why Postgres in production

Render web services have ephemeral disks; a SQLite file is wiped on every
deploy/restart, destroying `social_posts`, the channel map, and
`human_post_queue`. This service's whole job is durable queue state, so
production is Postgres. SQLite remains the local-dev store.

## B. Store-selection behavior

A single async interface (`src/store/Store.js`) with two implementations,
selected by `createStore()` (`src/store/index.js`) — **no call-site branching**:

| Condition | Store | Driver |
|---|---|---|
| injected pg-compatible pool (`.query`) | `PgStore` | tests (PGlite) |
| string path / better-sqlite3 instance | `SqliteStore` | local |
| `DATABASE_URL` set | `PgStore` | `pg.Pool` (production) |
| else | `SqliteStore` | `better-sqlite3` |

`PgStore` works against **any** object exposing async `query(text, params) → {rows}`
— `pg.Pool` in production, in-process **PGlite** (real Postgres compiled to WASM)
in tests. Both stores use identical columns/states and store JSON as TEXT +
booleans as 0/1, sharing one row-mapper, which is what makes them interchangeable.
Boot log confirms selection (`[social] Datastore: SQLite (…)` / `… Postgres …`).

## C. Postgres test run result

```
npm test                 → 43 pass / 0 fail   (SQLite)
TEST_STORE=pg npm test   → 43 pass / 0 fail   (PgStore over PGlite — real Postgres SQL)
```
`store-contract.test.js` additionally runs its parity assertions against **both**
stores in a single pass, including the idempotent-`setChannels` check.

## D. `setup:channels` idempotency

Confirmed in both stores: `setChannels(brand, …)` replaces the brand's channel
set (SQLite: DELETE+INSERT in a txn; Postgres: DELETE + `INSERT … ON CONFLICT
(brand, channel_id) DO UPDATE`). Re-running on redeploy yields no duplicate rows
and prunes channels that disappeared — asserted by `store-contract.test.js`.

## E. `PUBLIC_BASE_URL` / image-URL path

Verified: `BufferPublisher._imageAssetsFor` builds the asset URL from
`config.publicBaseUrl` for local upload paths (absolute URLs pass through), and
uploads are served at `/uploads/*`. `publicBaseUrl` now falls back to Render's
injected `RENDER_EXTERNAL_URL`, so deployed image posts hand Buffer a reachable
link with no manual config.

## F. What changed (and what did NOT)

- **Changed:** introduced `src/store/*`; `src/db.js` is now a thin facade;
  `createStore()` is async and env-selected; call sites gained `await` (worker,
  server, enqueue, BufferPublisher store calls, setup script, tests). Added
  `render.yaml`, `pg`, and dev-dep `@electric-sql/pglite`.
- **NOT changed:** the state machine (`src/state.js`), the drafter, all Buffer
  GraphQL (`buffer-client.js`), the retry/backoff/idempotency logic, routing, and
  the publish flow. The only edits to `worker.js`/`BufferPublisher.js` were adding
  `await` to store calls — zero behavioral change (proved by the unchanged,
  still-green logic tests now running on both stores).

## G. Still pending (needs the live key + a deploy)

The image-post verification can only happen on the deployed instance (Buffer must
reach a public image URL). With `BUFFER_API_KEY` set and the service live on
Render:
- [ ] Live introspection reconfirms the `@oneOf AssetInput` image format still
      matches (`npm run introspect`) — fix the one adapter file + note here if it
      diverged.
- [ ] Channel map populated on the **Postgres** DB (`npm run setup:channels propzombie`).
- [ ] Text test post — Buffer id: ________ · dashboard state: ________
- [ ] **Image** test post (PropZombie FB Page) — Buffer id: ________ · image intact in queue: ____
- [ ] Console operated from a **phone browser** on the public Render URL after login.
