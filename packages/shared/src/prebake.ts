/**
 * Pre-baked face windows.
 *
 * Generating a face on demand on Modal pays a GPU cold-start (~$). To keep the
 * carousel cheap we pre-render a fixed grid of slot ranges into a Modal Volume
 * once, then serve them as static JPEGs (CPU + Cloudflare cache) for free.
 *
 * Layout: PREBAKE_WINDOW_COUNT windows of PREBAKE_WINDOW_SIZE consecutive
 * slots each, evenly spaced across the slot range and centered within their
 * slice. A new visitor is dropped into a randomly-picked window so most
 * impressions never touch the GPU; the user can still scroll out of the
 * window into "empty" slots which simply show the silhouette fallback.
 *
 * Anchor positions are derived from POPULATION_BASELINE (the static day-zero
 * total), not currentTotalSlots(), so the on-disk file names stay valid as
 * the population number ticks up daily.
 */

// Mirrored from index.ts intentionally to avoid an import cycle. Update both
// in lockstep — the Python side in services/face-generator/prebake.py also
// depends on this constant matching.
const POPULATION_BASELINE = 8_289_468_500n;

export const PREBAKE_WINDOW_COUNT = 100;
export const PREBAKE_WINDOW_SIZE = 100;

const STEP: bigint = POPULATION_BASELINE / BigInt(PREBAKE_WINDOW_COUNT);
const HALF_WINDOW: bigint = BigInt(Math.floor(PREBAKE_WINDOW_SIZE / 2));
const FULL_WINDOW: bigint = BigInt(PREBAKE_WINDOW_SIZE);

/** Start slot of every pre-baked window, in order. */
export function prebakeAnchors(): bigint[] {
  const anchors: bigint[] = [];
  for (let i = 0; i < PREBAKE_WINDOW_COUNT; i++) {
    const center = STEP * BigInt(i) + STEP / 2n;
    const start = center > HALF_WINDOW ? center - HALF_WINDOW : 0n;
    anchors.push(start);
  }
  return anchors;
}

/** Pick one anchor uniformly at random. Used by SSR to land each visitor
 *  inside a fresh window per request. */
export function randomPrebakeAnchor(rng: () => number = Math.random): bigint {
  const idx = Math.floor(rng() * PREBAKE_WINDOW_COUNT);
  return prebakeAnchors()[idx]!;
}

/** O(1) check — does `slot` fall in any pre-baked window? */
export function isPrebaked(slot: bigint): boolean {
  if (slot < 0n || slot >= POPULATION_BASELINE) return false;
  const sliceIdx = slot / STEP;
  if (sliceIdx >= BigInt(PREBAKE_WINDOW_COUNT)) return false;
  const center = STEP * sliceIdx + STEP / 2n;
  const start = center > HALF_WINDOW ? center - HALF_WINDOW : 0n;
  const end = start + FULL_WINDOW;
  return slot >= start && slot < end;
}

/** Pick a random slot inside a specific window. */
export function randomSlotInWindow(anchor: bigint, rng: () => number = Math.random): bigint {
  const offset = BigInt(Math.floor(rng() * PREBAKE_WINDOW_SIZE));
  return anchor + offset;
}
