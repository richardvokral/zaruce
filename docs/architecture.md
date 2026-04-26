# Architecture

```
┌────────────┐   ┌──────────────┐   ┌───────────────────┐   ┌──────────┐
│  Browser   │──▶│  Vercel CDN  │──▶│  Astro app        │──▶│   Neon   │
│ (carousel) │   │  (immutable  │   │  /api/assign      │   │ Postgres │
│            │   │   for /face) │   │  /api/counter     │   └──────────┘
└─────┬──────┘   └──────┬───────┘   │  /api/face/[id]   │   ┌──────────┐
      │                 │           │  /api/admin/*     │──▶│ Upstash  │
      │ selfie attrs    │           └─────────┬─────────┘   │  Redis   │
      ▼ (on-device)     │                     │ 302         └──────────┘
┌────────────┐          │                     ▼
│  classify  │          │           ┌───────────────────┐
│  bucketId  │          └──────────▶│  Modal — A10G     │
└────────────┘                      │  StyleGAN3 +      │
                                    │  /admin/* routes  │
                                    └───────────────────┘
```

## Visitor request flow

A first-time visitor lands on the page:

1. **HTML** is served by Vercel from the Astro server runtime. The frontmatter
   computes `currentTotalSlots()` and embeds it in `<main data-total-slots="…">`.
   Counter element shows yesterday's `total` SSR'd; the JS poller will
   correct it within 30 s if it's stale.
2. **Carousel boot**: `carousel.ts` reads `data-total-slots` and starts at
   slot index `total / 2`. The DOM track holds a pool of ~80 absolutely-
   positioned slots.
3. **Image lazy-load**: each visible slot creates an `<img src="/api/face/<id>.jpg">`.
   Vercel's edge cache hits if Cloudflare/Modal already served that id;
   otherwise the request 302-redirects to Modal:
   ```
   GET /api/face/12345.jpg
   → 302 https://<workspace>--zaruce-face-generator-face.modal.run/?slot=12345
   ```
   Modal computes `seed = HMAC(SEED_SALT, big-endian uint64(slot))[:4]`,
   runs StyleGAN3 inference, returns a JPEG with
   `Cache-Control: public, max-age=31536000, immutable`.
4. **Counter poll**: `counter.ts` calls `/api/counter` every 30 s,
   broadcasts `total` updates to `carousel.ts` via the
   `zaruce:total` custom event.
5. **Find your face (anonymous)**: button POSTs `/api/assign`. Server:
   - Per-IP rate-limit check via Upstash (window + daily).
   - Generates a random `bigint` slot index in `[0, currentTotalSlots())`.
   - `INSERT … ON CONFLICT (index) DO NOTHING` against Neon.
   - Up to 8 retries on collision (PRD §7 — at <1 % occupancy a clash is
     vanishingly rare).
   - `slot_counter` row is bumped by an `AFTER INSERT` trigger.
6. **Find your face (selfie)**: dialog opens, user picks an image.
   `selfie.ts` decodes locally, classifies into a bucket id, displays the
   six-line preview, asks for confirmation. On confirm: only the integer
   `attributeBucketId` is POSTed to `/api/assign`. The selfie file is never
   sent.

## Salt rotation runbook

Salt rotation regenerates the entire collection (every slot maps to a new
seed → new face). Cached responses keep their old image until the cache
TTL expires; new visitors see new generation.

1. `python admin.py rotate-salt --new-salt $(openssl rand -hex 32)` —
   updates the Modal secret group.
2. Update `SEED_SALT` in the Vercel project env vars to the same value.
3. Trigger a Vercel redeploy.
4. (Optional) Purge Cloudflare cache to fast-track the rollover.

The slot index → seed mapping is fully deterministic, so existing
permalinks (`/#4217893402`) keep pointing to a stable face *for that
generation*. Permalinks shared during a rotation will drift to the new
face after cache eviction; this is acceptable — it's the entire point of
salt rotation as an artistic refresh mechanism.

## Why these choices

- **Astro server endpoints over a separate Worker**: simpler ops surface,
  one Vercel project, env vars in one place.
- **Neon over Supabase**: requested by the user; the serverless driver
  works in Vercel Edge runtimes with no extra infra.
- **Upstash for rate limiting**: cheap, REST-based, runs in any runtime.
  Works around the lack of Cloudflare KV when not on Workers.
- **Modal for inference**: $30 starter credits cover ~50k cold faces;
  scale-to-zero between bursts of traffic. R2 / Cloudflare cache absorbs
  the long tail.
- **Random-retry slot reservation**: PRD §7's argument is correct at MVP
  occupancy levels. If we reach >50 % occupancy a deterministic free-list
  becomes worth the schema cost; the migration is straightforward.

## Open architectural questions

These map directly to PRD §12:

- Mobile gesture: horizontal swipe (current) vs vertical scroll. Decided
  by user testing post-launch.
- Counter accuracy: 30 s poll vs websocket. Currently poll, since a
  websocket means a stateful service per active visitor.
- Audio: out of scope for MVP.
- Resolution: 256 default, 512 via env flip.
