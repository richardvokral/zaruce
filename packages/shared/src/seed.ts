/**
 * Deterministic seed derivation: a slot index always produces the same StyleGAN seed
 * for a given salt. Salt rotation lets us regenerate the whole collection without
 * losing the deterministic mapping per generation.
 *
 * uint32(HMAC-SHA256(SALT, index_bytes)[:4])
 */

const encoder = new TextEncoder();

function indexToBytes(index: bigint): Uint8Array {
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setBigUint64(0, index, false);
  return out;
}

async function hmacSha256(salt: string, data: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(salt),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, data as BufferSource);
  return new Uint8Array(sig);
}

export async function seedForSlot(index: bigint, salt: string): Promise<number> {
  const mac = await hmacSha256(salt, indexToBytes(index));
  return new DataView(mac.buffer, mac.byteOffset, 4).getUint32(0, false);
}

/**
 * Pick a seed from a bucket of pre-classified seeds, deterministically by slot.
 * Used by the selfie-inspired flow so the same slot always lands on the same
 * face even though the bucket contains thousands of candidates.
 */
export async function pickSeedFromBucket(
  index: bigint,
  bucketSeeds: readonly number[],
  salt: string,
): Promise<number> {
  if (bucketSeeds.length === 0) {
    throw new Error("Empty bucket — caller must fall back to nearest neighbor");
  }
  const mac = await hmacSha256(salt, indexToBytes(index));
  const pick = new DataView(mac.buffer, mac.byteOffset, 4).getUint32(0, false);
  return bucketSeeds[pick % bucketSeeds.length]!;
}
