# social-posting-service

A **standalone, cross-brand** social posting service. It drafts copy (Anthropic),
posts/schedules through **Buffer's GraphQL API**, and ships a **mobile operator
console** for compose → review → status. It serves both **PropZombie** and
**CrewMando** from one place.

> **Deliberately separate from the engine.** This service owns its own deps,
> datastore, config, and deploy unit. It does **not** import engine code, share
> the engine's database, or reference engine conventions (`slice_source`, etc.).
> The only inbound coupling is one optional enqueue surface (below). It never
> calls back into the engine.

---

## Architecture at a glance

```
            ┌───────────── this service (one deploy unit) ─────────────┐
 console ──►│  enqueue() ─► social_posts(drafted)                       │
 POST       │      │                                                    │
 /enqueue ──►      ▼   worker                                           │
            │   drafter (Anthropic ─or─ heuristic)                      │
            │      │                                                    │
            │      ├─ destination=buffer ──► awaiting_review ──(approve)─┼─► BufferPublisher ─► Buffer GraphQL
            │      │        (auto_publish=true skips review → queued)   │        │
            │      │                                                    │        └─ 5xx/429 ×3 ─► human_post_queue
            │      └─ destination=manual_* ─► human_post_queue ─────────┼──► (operator posts by hand)
            └──────────────────────────────────────────────────────────┘
```

- **`SocialPublisher`** interface (`publish`, `schedule`, `getStatus`) with
  **`BufferPublisher`** as the only implementation. Beta API → we keep the seam.
- **Brand-agnostic:** every publish resolves `brand → channel-ID map` from the
  datastore (populated by the setup script). Adding CrewMando is a setup run, not
  a code change.
- **Adapter isolation:** every Buffer GraphQL string lives in
  `src/publisher/buffer-client.js`. Schema shift = one file changes.

---

## Run locally

```bash
npm install
cp .env.example .env        # then edit: at minimum set CONSOLE_PASSWORD
npm start                   # http://localhost:4000  (console at /)
```

Without `BUFFER_API_KEY` the service still runs: the drafter falls back to a
heuristic formatter and posting to Buffer is disabled (approved posts will fail
to Buffer and land in the human-post queue). Set the key to post for real.

### One-time Buffer setup (with the key)

```bash
# 1) Prove the live schema matches the adapter (writes schema-introspection.json)
npm run introspect

# 2) Discover connected channels and persist the brand → channel-ID map
npm run setup:channels propzombie
#   ...later, when CrewMando channels are connected:
# npm run setup:channels crewmando
```

Channel IDs are **never** hardcoded — they live in the datastore after setup.

### Tests

```bash
npm test                    # node:test, offline (Buffer + Anthropic mocked); SQLite store
TEST_STORE=pg npm test      # same suite against real Postgres semantics (in-process PGlite)
```

---

## Datastore — SQLite local, Postgres in production

One storage interface (`src/store/Store.js`), two implementations selected by env
via `createStore()` — **no call-site branching anywhere**:

| Env | Store | Why |
|---|---|---|
| `DATABASE_URL` set | **`PgStore`** (`pg`) | Render disks are ephemeral — SQLite would be wiped on every deploy, destroying queue state. Production must be durable Postgres. |
| otherwise | **`SqliteStore`** (`better-sqlite3`) at `SQLITE_PATH` | Zero-setup local dev; prebuilt binary on Node 20–25, no compile. |

Both implement the **identical async interface** (`createPost`, `updatePost`,
`listPosts`, `addHumanPost`, `setChannels`, `kvGet/Set`, …) with the same
columns, states, and JSON-as-TEXT shape, so they are interchangeable. The full
test suite runs green against **both** (`TEST_STORE=pg npm test` runs it against
real Postgres via in-process PGlite).

> **`DATABASE_URL` must point at a Postgres that is NOT the engine's.** This
> service's tables (`social_posts`, `human_post_queue`, `channels`, `kv`) live in
> its own database; it never touches the engine's DB.

## Deploy to Render

`render.yaml` is a Blueprint that provisions the web service **and** a managed
Postgres, wiring the DB connection string into the service as `DATABASE_URL`.

1. Push this directory to a Git repo Render can read.
2. Render Dashboard → **New → Blueprint** → select the repo. Render reads
   `render.yaml` and creates `social-posting-service` (web) + `social-posting-db`
   (Postgres).
3. Set the `sync: false` secrets in the dashboard: **`BUFFER_API_KEY`**,
   **`CONSOLE_PASSWORD`**, optional `CONSOLE_PASSWORD_ES`, `SERVICE_TOKEN` (only
   if the engine will call `POST /enqueue`), `ANTHROPIC_API_KEY` (optional).
   `SESSION_SECRET` is auto-generated; `DATABASE_URL` is auto-wired.
4. Deploy. The service selects `PgStore` automatically (because `DATABASE_URL` is
   present) and runs `CREATE TABLE IF NOT EXISTS` on boot.
5. With the key set, run the one-time channel setup against the live DB from the
   Render shell: `npm run setup:channels propzombie` (idempotent — safe to re-run).

**`PUBLIC_BASE_URL` must equal the public service URL** (e.g.
`https://social-posting-service.onrender.com`) because Buffer fetches post images
by URL. Render injects `RENDER_EXTERNAL_URL` automatically and the app falls back
to it, so image posts work without setting `PUBLIC_BASE_URL` by hand; set it only
to override (custom domain).

---

## Environment variables

| Var | Required | Purpose |
|---|---|---|
| `CONSOLE_PASSWORD` | **yes** | Operator login for the console + API. |
| `CONSOLE_PASSWORD_ES` | no | Optional 2nd login (e.g. Spanish-copy reviewer). |
| `SESSION_SECRET` | prod | Signs session cookies. Use a random 32+ byte value. |
| `BUFFER_API_KEY` | for posting | Buffer personal API key (`Settings → API`). Never logged. |
| `BUFFER_API_URL` | no | Defaults to `https://api.buffer.com`. |
| `BUFFER_ORGANIZATION_ID` | no | Pin the org; otherwise auto-discovered. |
| `ANTHROPIC_API_KEY` | no | Enables the AI drafter; otherwise heuristic fallback. |
| `ANTHROPIC_MODEL` | no | Defaults to `claude-sonnet-4-6`. |
| `PUBLIC_BASE_URL` | for image posts | Public URL of THIS service. Buffer fetches uploaded images by URL, so it must be reachable by Buffer (real https on deploy; **localhost will not work for image posts**). |
| `SERVICE_TOKEN` | no | Enables `POST /enqueue`; required in its `X-Service-Token` header. Unset = endpoint disabled. |
| `SQLITE_PATH` | no | SQLite file path (default `./data/social.db`). |
| `DATABASE_URL` | no | Postgres deploy target (separate from the engine). |

On Render: set these in the dashboard. Do **not** inline secrets in any committed
file. (`render.yaml` is intentionally not provided so this service is platform-agnostic.)

---

## Wiring — the integration contract (the engine reads ONLY this section)

Work enters as a single `social_posts` row in state `drafted`. There are exactly
two ways to create one; **both call the same `enqueue()`**:

### A. In-process (preferred when co-located)

```js
const { createStore } = require('./src/db');
const { enqueue } = require('./src/enqueue');
const store = createStore(process.env.SQLITE_PATH);

enqueue(store, {
  brand: 'propzombie',                 // 'propzombie' | 'crewmando'   (required)
  brief: 'Off-market 3/2 in Tampa…',   // drafter input               (required)
  intended_post_time: '2026-07-01T15:00:00Z', // optional ISO 8601; honored as the schedule
  image: 'https://cdn.example.com/x.jpg',      // optional public image URL
  image_alt: 'a brick duplex',                 // optional
  auto_publish: false,                 // default false → human review first
  destination: 'buffer',               // 'buffer' (default) | 'manual_fb_group' | 'manual_whatsapp'
});
```

### B. Over HTTP (when the engine is remote)

```bash
curl -X POST "$SERVICE_URL/enqueue" \
  -H "Content-Type: application/json" \
  -H "X-Service-Token: $SERVICE_TOKEN" \
  -d '{"brand":"propzombie","brief":"Off-market 3/2 in Tampa, ARV 280k, asking 195k","auto_publish":false}'
# → 201 {"id":"<uuid>","state":"drafted"}
```

That single row (or `POST /enqueue`) is the **entire** programmatic contract.
The engine never calls Buffer, never imports poster code, and is never called
back by this service.

### Job-row shape (state machine)

`drafted → awaiting_review → queued → posting → published`
with `awaiting_review → rejected` (terminal) and `queued|posting → failed`
(routed to `human_post_queue` with the verbatim error). `auto_publish=true`
skips `awaiting_review`. Manual destinations skip Buffer entirely and land in
`human_post_queue` as manual-post cards.

---

## The console (mobile-first, served at `/`)

Behind the login. Three thumb-reachable views via a bottom tab bar:

- **Compose** — brand toggle, destination, brief, optional image (phone
  camera/roll), optional intended time, `auto_publish` toggle (default off).
- **Review** — `awaiting_review` posts with copy + image + target channels;
  **Approve** / **Edit** (inline, stays in review) / **Reject**.
- **Status** — recent posts with state, Buffer ids when published, the verbatim
  error when failed, and `human_post_queue` cards with one-tap **Copy text**.

A PWA manifest is included (`/assets/manifest.webmanifest`) so the console can be
added to a phone home screen — **optional**, not required for mobile access.

The console also has a **Schedule** tab (see Auto-scheduler below).

## Auto-scheduler (content calendar → Buffer, approve-first)

A scheduling layer that reads a content calendar, generates each post with the
drafter, and pushes the batch to Buffer as **scheduled drafts awaiting your
approval**. You approve the batch from the **Buffer mobile app** — nothing
publishes until you do.

- **Calendar:** `src/scheduler/content-calendar.js` — one entry per post
  (`brand`, `channel`, `metro`, `dayOffset`, `slot`, `brief`). Intentionally
  editable; add a whole month here. Entries whose channel isn't a registered
  Buffer channel for the brand are skipped (e.g. `linkedin`/`instagram` until
  connected).
- **Slots/timezone:** posting times are Central (`America/Chicago`), DST-aware
  via `luxon` — `dueAt` carries the correct `-05:00`/`-06:00` offset year-round.
- **Console → Schedule tab:** brand filter, batch start date, **Preview**
  (dry-run; shows exactly what *would* be scheduled, no Buffer call, no rows),
  and **Schedule to Buffer** (pushes the batch). The **Status** tab shows each
  `scheduled_posts` row's state. Mobile-first.
- **State:** rows live in `scheduled_posts`
  (`planned → scheduled → awaiting_approval`, or `failed`/`skipped`), with the
  Buffer post id stored. Re-running a batch is **idempotent** (same
  brand+channel+dueAt+copy is skipped, never duplicated). Rate-limit/5xx errors
  back off and retry, then mark that one row `failed` and continue.

### Scheduling + approval

The scheduler sends each post to Buffer as `customScheduled` + `dueAt`, so it
lands on Buffer's schedule for that Central-time slot. **You review and approve
posts directly in the Buffer app** — that's where the approval workflow lives, so
the service pushes generated content straight to Buffer with no extra approval
step of its own. (Note: with a plain scheduled post Buffer publishes at `dueAt`
once approved in its app; manage timing/approval there.)

### Images are text-only for now (durable hosting needed)

Buffer fetches post media from a public URL that must stay live until the post
publishes. This service serves uploads from `PUBLIC_BASE_URL/uploads` — **public
but on Render's ephemeral disk (not durable)**, so a restart between scheduling
and `dueAt` would break a scheduled image. The scheduler therefore runs
**text-only** (the sample calendar has no images). To enable scheduled images,
add durable public hosting (Cloudflare R2 or similar) and serve image URLs from
there; then set `deps.allowImages` and put `imageUrl` on calendar entries.
