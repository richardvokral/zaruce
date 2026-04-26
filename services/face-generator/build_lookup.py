"""Offline / on-Modal builder for `bucket_seeds.json`.

For each of the 3 888 attribute buckets we want a list of StyleGAN seeds
known to produce a face with that combination of attributes. The selfie
flow reads this file at request time and picks one seed from the matching
bucket via HMAC(slot_index).

Workflow:
    1. Generate N random faces (N = 50 000 by default).
    2. For each face, run the classifier suite to assign it a bucket id.
    3. Append the seed to that bucket's list.
    4. Write `/lookup/bucket_seeds.json`, then `lookup_volume.commit()`.

Classifiers used here are placeholders; before launch they should be replaced
with audited models (FairFace / a calibrated age estimator). The PRD §11
flags fairness as a high-probability risk — this is the file that has to
stay current.
"""

from __future__ import annotations

import json
import os
import random
from typing import Optional


LOOKUP_PATH = "/lookup/bucket_seeds.json"


def _bucket_id(age: int, presentation: int, hair_color: int, skin_tone: int, glasses: bool, hair_length: int) -> int:
    # Mirror of bucketId() in packages/shared/src/attributes.ts.
    n = 0
    n = n * 6 + age
    n = n * 3 + presentation
    n = n * 6 + hair_color
    n = n * 6 + skin_tone
    n = n * 2 + (1 if glasses else 0)
    n = n * 3 + hair_length
    return n


def classify(_face_image) -> Optional[tuple[int, int, int, int, bool, int]]:
    """Stub classifier. Returns a (age, presentation, hair_color, skin_tone, glasses, hair_length)
    tuple, all integer-encoded. Replace with real models before launch.

    The MVP build runs a deliberately uniform random classifier so the
    resulting JSON exercises every bucket end-to-end in tests; the production
    swap-in needs:

    - FairFace for age / skin_tone / presentation
    - dlib facial landmarks for glasses presence
    - HSV histogram heuristic for hair_color
    - Edge / contour heuristic for hair_length
    """
    return (
        random.randint(0, 5),
        random.randint(0, 2),
        random.randint(0, 5),
        random.randint(0, 5),
        random.random() < 0.2,
        random.randint(0, 2),
    )


def build_lookup(samples: int = 50_000, generator=None) -> dict[str, list[int]]:
    """Sample seeds, generate faces, classify them, and group by bucket id.

    `generator` is expected to be a callable taking a seed and returning a
    PIL.Image; when called inside the Modal `admin_regen` function it's the
    `FaceGenerator.generate` method bound to the running container.
    """
    buckets: dict[str, list[int]] = {}
    for _ in range(samples):
        seed = random.getrandbits(32)
        face = generator(seed) if generator else None
        result = classify(face)
        if result is None:
            continue
        age, pres, hair_color, skin, glasses, hair_len = result
        bid = str(_bucket_id(age, pres, hair_color, skin, glasses, hair_len))
        buckets.setdefault(bid, []).append(seed)
    return buckets


def regen_bucket(bucket_id: int, samples: int) -> int:
    """Re-sample seeds for a single bucket id. Called by /admin/regen."""
    existing: dict[str, list[int]] = {}
    if os.path.exists(LOOKUP_PATH):
        with open(LOOKUP_PATH) as fh:
            existing = json.load(fh)

    fresh = build_lookup(samples=samples)
    seeds = fresh.get(str(bucket_id), [])
    if seeds:
        existing[str(bucket_id)] = seeds
        with open(LOOKUP_PATH, "w") as fh:
            json.dump(existing, fh)
    return len(seeds)


def write_full_lookup(samples: int) -> dict[str, int]:
    """Build the entire lookup from scratch and persist it. Returns a
    {bucket_id: count} map for reporting."""
    buckets = build_lookup(samples=samples)
    os.makedirs(os.path.dirname(LOOKUP_PATH), exist_ok=True)
    with open(LOOKUP_PATH, "w") as fh:
        json.dump(buckets, fh)
    return {bid: len(seeds) for bid, seeds in buckets.items()}
