# 8 Billion Faces — `zaruce`

> One AI-generated face for every person on Earth. Most slots are still
> empty. Yours is somewhere in here.

A single-page experience: a virtualized horizontal carousel with one slot
per person on Earth, each backed by an AI-generated face produced lazily by
StyleGAN3. Visitors are assigned a free slot. An opt-in selfie flow biases
the generation via a small set of generic attributes that never leave the
browser.

This repo is the MVP scaffold. It boots end-to-end on free / cheap tiers:
**Vercel** (frontend + API), **Neon** (Postgres), **Upstash** (Redis),
**Modal** (StyleGAN3 GPU inference).

## Repo layout

```
apps/web/                  Astro app — single page + API routes (Vercel adapter)
  src/pages/index.astro      The carousel page
  src/pages/api/             /api/assign, /api/counter, /api/face/[id], /api/admin/purge-attributes, /api/health
  src/scripts/               carousel.ts, counter.ts, selfie.ts (run in browser)
  src/server/                db.ts, rate-limit.ts, visitor.ts (server-only helpers)
packages/shared/           TS shared by web + Modal seed math
  src/index.ts               currentTotalSlots() — population grows ~190k/day
  src/seed.ts                HMAC-SHA256 deterministic seed derivation
  src/attributes.ts          3 888 attribute buckets for the selfie flow
services/face-generator/   Modal Python app (StyleGAN3 on A10G)
  main.py                    HTTP endpoints (face + admin/*)
  population.py              Python mirror of currentTotalSlots()
  build_lookup.py            Offline classifier → bucket_seeds.json
  admin.py                   CLI for status / regen / warm / rotate-salt / build-lookup
db/migrations/             0001_init.sql + 0002_seed_buckets.sql (3 888 rows)
scripts/gen-bucket-seed.mjs Regenerates 0002 from the attribute taxonomy
```

## Total-slots math

The cap is **not** a static 8 × 10⁹ — it tracks Earth's population, which
grows ~0.84 %/year. We anchor at **2026-04-26 = 8 289 468 500** and add
**190 718 slots/day**. Same formula in TS (`currentTotalSlots`) and Python
(`current_total_slots`); both are pure functions of the current UTC date,
so no DB row, no cron, no race. Each request recomputes locally; the
counter poll re-broadcasts the value every 30 s so a session left open
overnight grows its upper bound at midnight.

To bump the baseline (e.g. when the UN releases a new estimate):

1. Update `POPULATION_BASELINE`, `BASELINE_EPOCH_MS`, `DAILY_INCREMENT`
   in `packages/shared/src/index.ts`.
2. Mirror them in `services/face-generator/population.py`.
3. Redeploy both web + Modal.

## Local development

```bash
pnpm install
pnpm --filter @zaruce/web dev
```

That's it. With no env vars set the API endpoints fall back to mocked
responses (random slot indices, no rate limiting, no DB writes), so the
carousel is fully interactive on first run.

`pnpm typecheck` should pass across all workspaces.

## Production setup

### 1. Accounts

| Service    | Why                              | Free tier?       |
|------------|----------------------------------|------------------|
| Vercel     | Astro frontend + API routes      | yes              |
| Neon       | Postgres slot store              | yes              |
| Upstash    | Redis for per-IP rate limiting   | yes              |
| Modal      | StyleGAN3 GPU inference          | $30 starter cred |
| Cloudflare | (optional) CDN in front of Modal | yes              |

### 2. Modal — deploy the face generator

```bash
pip install modal
modal token new
```

Create a Modal secret group named `zaruce-secrets` with:

| Key             | Value                                                     |
|-----------------|-----------------------------------------------------------|
| `SEED_SALT`     | 32+ random bytes hex-encoded — production secret          |
| `ADMIN_TOKEN`   | bearer token gating /admin/* on Modal and Vercel          |
| `WEIGHTS_URL`   | direct URL to a StyleGAN3 `.pkl` (FFHQ-U is a good start) |
| `FACE_RESOLUTION` | `256` (or `512` at 4× cost)                             |

Deploy:

```bash
cd services/face-generator
modal deploy main.py
```

Modal returns a public URL like

```
https://<workspace>--zaruce-face-generator-face.modal.run
```

Note this URL — it's `MODAL_FACE_BASE` for Vercel.

First-time only — build the bucket lookup so the selfie flow has seeds to
choose from:

```bash
pip install -r requirements-admin.txt
python admin.py build-lookup --samples 50000
```

That kicks off a Modal run on A10G (1–3 hours). The CLI tail-follows the
job; on completion `bucket_seeds.json` lands in the shared `lookup_volume`
and the next cold start of `face_endpoint` will pick it up.

### 3. Neon — provision Postgres

Create a project at neon.tech. Copy the **pooled** connection string
(host ends in `-pooler.<region>.aws.neon.tech`). Then:

```bash
psql "$DATABASE_URL" -f db/migrations/0001_init.sql
psql "$DATABASE_URL" -f db/migrations/0002_seed_buckets.sql
```

That sets up `slots`, `attribute_buckets` (3 888 rows), `slot_counter`
(denormalized counter kept in sync by trigger), and the
`purge_expired_attributes()` retention function.

### 4. Upstash — provision Redis

Create a Redis database. Copy the **REST URL** and **REST token**.

### 5. Vercel — connect the repo

- Import the GitHub repo into Vercel.
- Set **Root Directory** to `apps/web`.
- Leave install / build commands at the auto-detected defaults — `apps/web/vercel.json` already overrides them to use pnpm from the repo root, and the committed `pnpm-lock.yaml` ensures reproducible installs.
- Branch deploys are automatic; production tracks `main`.

Add these environment variables in the Vercel dashboard (all environments):

| Variable                       | Source                                     |
|--------------------------------|--------------------------------------------|
| `DATABASE_URL`                 | Neon pooled connection string              |
| `UPSTASH_REDIS_REST_URL`       | Upstash REST URL                           |
| `UPSTASH_REDIS_REST_TOKEN`     | Upstash REST token                         |
| `SEED_SALT`                    | same value as the Modal secret             |
| `VISITOR_HASH_KEY`             | independent random secret (32+ bytes)      |
| `MODAL_FACE_BASE`              | Modal endpoint URL from step 2             |
| `ADMIN_TOKEN`                  | same value as the Modal admin token        |
| `PUBLIC_FACE_BASE`             | leave empty (use same-origin /api/face/*)  |
| `PUBLIC_API_BASE`              | leave empty (use same-origin /api/*)       |
| `RATE_LIMIT_WINDOW_SEC`        | `600` (default)                            |
| `RATE_LIMIT_MAX`               | `1` (default)                              |
| `DAILY_LIMIT`                  | `10` (default)                             |
| `ATTRIBUTE_RETENTION_DAYS`     | `90` (default)                             |

### 6. Vercel Cron — daily attribute purge

Add a Vercel Cron Job:

| Field        | Value                                            |
|--------------|--------------------------------------------------|
| Path         | `/api/admin/purge-attributes`                    |
| Method       | `POST`                                           |
| Schedule     | `0 3 * * *` (03:00 UTC daily)                    |
| Headers      | `Authorization: Bearer ${ADMIN_TOKEN}` (Vercel UI) |

The handler runs `SELECT purge_expired_attributes()` against Neon. PRD §11
retention is 90 days; tune via `ATTRIBUTE_RETENTION_DAYS`.

## Admin CLI

```bash
cd services/face-generator
export MODAL_FACE_BASE=https://...modal.run
export ADMIN_TOKEN=...

python admin.py status                            # bucket coverage
python admin.py warm --indices 0,1,2,3            # pre-warm faces
python admin.py regen-bucket --bucket-id 1234     # re-sample one bucket
python admin.py build-lookup --samples 50000      # full rebuild (modal run)
python admin.py rotate-salt --new-salt $(openssl rand -hex 32)
```

## Privacy

- **Selfie images never leave the browser.** Attribute classification runs
  on-device; only a small integer bucket id is sent.
- **No biometric data is persisted.** No face embeddings, no landmarks, no
  hashed images.
- **What we do store**, per-visitor: an opaque HMAC of `ip|user-agent`
  (`visitor_hash`), and — only when the user opts into the selfie flow —
  the integer `attribute_bucket_id` and a `attributes_purge_at` timestamp.
- **Retention**: `attribute_bucket_id` is anonymized after 90 days by the
  daily cron job (configurable via `ATTRIBUTE_RETENTION_DAYS`).
- See `docs/privacy.md` for the full GDPR cross-reference.

## Status

Concept → MVP scoping (PRD v0.2). This scaffold lands milestones M1–M3 and
the M4b groundwork.

Known gaps before launch:

- `apps/web/src/scripts/selfie.ts` ships a heuristic classifier stub. The
  privacy promise depends on a real on-device model (MediaPipe FaceLandmarker
  + a small ONNX age/skin-tone classifier). Swap before launch.
- `services/face-generator/build_lookup.py` uses random sampling for the
  attribute classifier. Replace with FairFace + dlib before launch and
  audit for bias on diverse test sets.
- No analytics integration.
- No design pass beyond the minimal dark theme.
