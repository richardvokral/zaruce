-- 0001_init.sql — initial schema for Zaruce.
-- Run against a fresh Neon Postgres database (or any Postgres ≥14).
--   psql "$DATABASE_URL" -f db/migrations/0001_init.sql
-- Then apply the bucket seed in 0002_seed_buckets.sql.

BEGIN;

-- ---------------------------------------------------------------------------
-- Static lookup of all 3 888 attribute combinations.
-- IDs are deterministic and match `bucketId()` in @zaruce/shared/attributes.
-- ---------------------------------------------------------------------------

CREATE TABLE attribute_buckets (
  id            INT PRIMARY KEY,
  age_bucket    SMALLINT NOT NULL,
  presentation  SMALLINT NOT NULL,
  hair_color    SMALLINT NOT NULL,
  skin_tone     SMALLINT NOT NULL,
  glasses       BOOLEAN  NOT NULL,
  hair_length   SMALLINT NOT NULL,
  UNIQUE (age_bucket, presentation, hair_color, skin_tone, glasses, hair_length)
);

-- ---------------------------------------------------------------------------
-- One row per assigned slot. Most of the 8B address space stays empty.
-- ---------------------------------------------------------------------------

CREATE TABLE slots (
  index               BIGINT PRIMARY KEY,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  visitor_hash        BYTEA NOT NULL,
  attribute_bucket_id INT NULL REFERENCES attribute_buckets(id) ON DELETE SET NULL,
  attributes_purge_at TIMESTAMPTZ NULL
);

CREATE INDEX slots_created_idx ON slots(created_at);
CREATE INDEX slots_purge_idx ON slots(attributes_purge_at)
  WHERE attribute_bucket_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Denormalized counter so /api/counter is O(1) on hot traffic.
-- Kept in sync by a trigger on slots.
-- ---------------------------------------------------------------------------

CREATE TABLE slot_counter (
  id        SMALLINT PRIMARY KEY DEFAULT 1,
  occupied  BIGINT NOT NULL DEFAULT 0,
  CHECK (id = 1)
);
INSERT INTO slot_counter (id, occupied) VALUES (1, 0);

CREATE OR REPLACE FUNCTION bump_slot_counter() RETURNS trigger AS $$
BEGIN
  IF (TG_OP = 'INSERT') THEN
    UPDATE slot_counter SET occupied = occupied + 1 WHERE id = 1;
  ELSIF (TG_OP = 'DELETE') THEN
    UPDATE slot_counter SET occupied = GREATEST(occupied - 1, 0) WHERE id = 1;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER slots_counter_trg
  AFTER INSERT OR DELETE ON slots
  FOR EACH ROW EXECUTE FUNCTION bump_slot_counter();

-- ---------------------------------------------------------------------------
-- Retention: anonymize attribute bucket id after the configured purge date.
-- Called daily by /api/admin/purge-attributes (Vercel Cron). The slot itself
-- is kept; only the link to the attribute bucket is severed.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION purge_expired_attributes() RETURNS BIGINT AS $$
DECLARE
  affected BIGINT;
BEGIN
  UPDATE slots
     SET attribute_bucket_id = NULL,
         attributes_purge_at = NULL
   WHERE attribute_bucket_id IS NOT NULL
     AND attributes_purge_at IS NOT NULL
     AND attributes_purge_at <= now();
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$ LANGUAGE plpgsql;

COMMIT;
