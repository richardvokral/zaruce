# Privacy

## Promise

The faces in the carousel are AI-generated fiction, not portraits. Even
the opt-in selfie flow — which biases the generator toward your "vibe" —
never sends your selfie to any server.

## What we send to a server

| Trigger                  | Data sent                                                     |
|--------------------------|---------------------------------------------------------------|
| Page load                | none beyond standard HTTP request metadata                    |
| Lazy-loading a face slot | `GET /api/face/<id>` — no cookies needed                      |
| Counter poll             | `GET /api/counter` — no body                                  |
| "Find your face" (anon)  | `POST /api/assign` with empty `{}` body                        |
| "Find your face" (selfie)| `POST /api/assign` with `{"attributeBucketId": <0..3887>}`    |

A user with browser devtools open can verify the third column directly.
No image data is ever in the request body.

## What we store

| Field                  | What it is                                       | Why we keep it                |
|------------------------|--------------------------------------------------|--------------------------------|
| `slots.index`          | the assigned slot                                | so the slot stays yours        |
| `slots.created_at`     | timestamp                                        | counter, abuse triage          |
| `slots.visitor_hash`   | HMAC-SHA256(`VISITOR_HASH_KEY`, `ip|user-agent`) | rate limiting, dedup           |
| `slots.attribute_bucket_id` | 0..3887, set only if selfie flow was used   | reproduce the same face later  |
| `slots.attributes_purge_at` | timestamp                                   | enforce retention boundary     |

We do **not** store:

- selfies, thumbnails, or any image data
- face embeddings, landmarks, or biometric vectors
- IP addresses (only their HMAC, which is non-reversible)
- user agents (only their HMAC)
- cookies beyond what the platform sets for session tracking

## Retention

`attribute_bucket_id` and `attributes_purge_at` are wiped to NULL after
**90 days** (configurable via `ATTRIBUTE_RETENTION_DAYS`). The slot row
itself stays, so your permalink keeps working — you just lose the
selfie-inspired generation if the cache also expires before then.

The retention job runs as a daily Vercel Cron job hitting
`/api/admin/purge-attributes`, which calls the Postgres function
`purge_expired_attributes()`.

## GDPR cross-reference

- **Lawful basis (Art. 6)**: legitimate interest. The data we store is
  the bare minimum to operate the service; the visitor hash isn't
  reversible to identify a person, the attribute bucket has cardinality
  3 888 (≈ 1.8 M people per bucket globally) and is retained for 90 days.
- **Sensitive categories (Art. 9)**: skin tone and gender presentation are
  potentially Art. 9 data. We mitigate by:
  - computing the bucket on-device, never uploading the source image,
  - storing only a 12-bit integer (the bucket id), and
  - anonymizing the link after 90 days.
- **Right to erasure**: any visitor can request deletion of their
  `slots` row by sending the slot index they want erased.
- **Data Processing Agreements**: in place with Vercel, Neon, Upstash,
  Modal as standard sub-processors.

## What this scaffold does *not* do yet

- Cookie banner. The site sets no cookies; if/when analytics is added
  this needs revisiting.
- ToS / Privacy Policy page. Draft text lives here; the launch deploy
  needs a /privacy route surfacing it to visitors.
- Erasure endpoint. The data model supports `DELETE FROM slots WHERE index
  = $1`; a request flow + verification UI is a follow-up.
