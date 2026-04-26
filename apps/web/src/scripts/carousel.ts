/**
 * Virtualized carousel of ~8 billion logical slots (today's world population —
 * the cap grows daily, see packages/shared/src/index.ts).
 *
 * The trick: the DOM never holds the full slot count, and the track never has
 * billions of pixels worth of width. We track a logical bigint position
 * (`centerIndex`) plus a sub-pixel offset, then render only a small window
 * around it. Drag / wheel input mutates the logical position, then a single
 * rAF loop reconciles the DOM (~80 absolutely-positioned slot divs).
 */

import { currentTotalSlots } from "@zaruce/shared";

const stage = document.getElementById("stage")!;
const carousel = document.getElementById("carousel")!;
const track = document.getElementById("track")!;
const positionEl = document.getElementById("position")!;
const positionIndexEl = document.getElementById("position-index")!;

// Initial cap from the SSR'd attribute. The counter poller can push a fresh
// value in via the `zaruce:total` custom event, e.g. when a session crosses
// midnight and the population baseline ticks up.
let total: bigint = BigInt(stage.dataset.totalSlots ?? currentTotalSlots().toString());

window.addEventListener("zaruce:total", (e) => {
  const next = (e as CustomEvent<{ total: string }>).detail?.total;
  if (!next) return;
  try {
    const parsed = BigInt(next);
    if (parsed > total) total = parsed;
  } catch { /* ignore malformed values */ }
});

// Same-origin defaults: when env is empty we use the Astro server endpoints
// at /api/face/<id> and /api/assign on this very deployment.
const FACE_BASE = (import.meta.env.PUBLIC_FACE_BASE || "/api/face").replace(/\/$/, "");
const API_BASE = (import.meta.env.PUBLIC_API_BASE || "").replace(/\/$/, "");

interface Layout {
  slotW: number;
  slotH: number;
  gap: number;
  step: number; // slotW + gap
  windowSize: number; // how many slots to keep mounted
}

function readLayout(): Layout {
  const styles = getComputedStyle(document.documentElement);
  const slotW = parseInt(styles.getPropertyValue("--slot-w")) || 200;
  const slotH = parseInt(styles.getPropertyValue("--slot-h")) || 200;
  const gap = parseInt(styles.getPropertyValue("--gap")) || 8;
  const step = slotW + gap;
  const visible = Math.ceil(window.innerWidth / step);
  const windowSize = visible + 24; // generous prefetch buffer on both sides
  return { slotW, slotH, gap, step, windowSize };
}

let layout = readLayout();

/** Logical center of the viewport, in slot units. May be fractional. */
let centerIndex: number = Number(total / 2n); // start at the middle
let velocity = 0; // px/frame inertia
let dragging = false;
let assignedIndex: bigint | null = null;

const slotPool: HTMLDivElement[] = [];
const mountedByIndex = new Map<string, HTMLDivElement>();

function clampCenter(c: number): number {
  // Allow a small overshoot for elastic feel; hard clamp at edges.
  const max = Number(total - 1n);
  if (c < 0) return 0;
  if (c > max) return max;
  return c;
}

function ensurePoolSize(n: number) {
  while (slotPool.length < n) {
    const el = document.createElement("div");
    el.className = "slot";
    el.setAttribute("role", "img");
    track.appendChild(el);
    slotPool.push(el);
  }
}

/**
 * Deterministic per-slot hue. Spreads the silhouette tints across the
 * color wheel using the golden-angle increment (137.508°), which gives
 * visually pleasing, non-repeating distribution for sequential indices.
 */
function slotHue(index: bigint): number {
  // Modulo on bigint then to number — keeps precision well past 2^53.
  return Number((index * 137n) % 360n);
}

function setSlotImage(el: HTMLDivElement, index: bigint) {
  const id = index.toString();
  if (el.dataset.index === id) return;
  el.dataset.index = id;
  el.setAttribute("aria-label", `Slot ${id}`);
  el.classList.toggle("you", assignedIndex !== null && index === assignedIndex);
  el.style.setProperty("--slot-hue", String(slotHue(index)));

  // Drop existing children and start fresh.
  el.replaceChildren();

  const img = new Image();
  img.loading = "lazy";
  img.decoding = "async";
  img.alt = "";
  img.src = `${FACE_BASE}/${id}.jpg`;
  img.addEventListener("load", () => img.classList.add("loaded"), { once: true });
  // On error we leave the silhouette + tinted background visible — no extra
  // styling required. Production behavior: a 404 here means "no face yet
  // generated" which is the expected state for ~7.999B slots out of 8B.
  el.appendChild(img);
}

function render() {
  layout = readLayout();
  const { step, windowSize } = layout;
  ensurePoolSize(windowSize);

  const half = Math.floor(windowSize / 2);
  const centerInt = Math.floor(centerIndex);
  const fractional = centerIndex - centerInt;

  // Build the set of indices we want mounted.
  const wanted = new Set<string>();
  for (let i = -half; i < windowSize - half; i++) {
    const idx = centerInt + i;
    if (idx < 0) continue;
    if (BigInt(idx) >= total) continue;
    wanted.add(idx.toString());
  }

  // Recycle slots not in the new window.
  const toRecycle: HTMLDivElement[] = [];
  for (const [id, el] of mountedByIndex) {
    if (!wanted.has(id)) {
      toRecycle.push(el);
      mountedByIndex.delete(id);
    }
  }

  // Assign each wanted index to a recycled or fresh pool element.
  let recycleCursor = 0;
  let poolCursor = 0;
  for (const id of wanted) {
    if (mountedByIndex.has(id)) continue;
    let el: HTMLDivElement;
    if (recycleCursor < toRecycle.length) {
      el = toRecycle[recycleCursor++]!;
    } else {
      // Find a pool element not currently mounted.
      while (poolCursor < slotPool.length && mountedByIndex.has(slotPool[poolCursor]!.dataset.index ?? "")) {
        poolCursor++;
      }
      el = slotPool[poolCursor++] ?? slotPool[0]!;
    }
    setSlotImage(el, BigInt(id));
    mountedByIndex.set(id, el);
  }

  // Position every mounted slot.
  for (const [id, el] of mountedByIndex) {
    const offsetSlots = Number(BigInt(id)) - centerIndex;
    const x = offsetSlots * step - layout.slotW / 2;
    el.style.transform = `translate3d(${x}px, 0, 0)`;
  }

  // Hide unused pool elements offscreen.
  for (const el of slotPool) {
    if (!mountedByIndex.has(el.dataset.index ?? "")) {
      el.style.transform = "translate3d(-99999px, 0, 0)";
    }
  }

  // Sync URL hash to current center (debounced via render loop).
  syncHash(centerInt);
  void fractional;
}

let pendingHash: number | null = null;
let hashTimer: number | null = null;
function syncHash(idx: number) {
  pendingHash = idx;
  if (hashTimer !== null) return;
  hashTimer = window.setTimeout(() => {
    hashTimer = null;
    if (pendingHash === null) return;
    const next = `#${pendingHash}`;
    if (location.hash !== next) {
      history.replaceState(null, "", next);
    }
  }, 250);
}

// ----- Input handling ---------------------------------------------------

let pointerStartX = 0;
let pointerLastX = 0;
let pointerStartCenter = 0;
let lastMoveTs = 0;

carousel.addEventListener("pointerdown", (e) => {
  dragging = true;
  carousel.classList.add("dragging");
  carousel.setPointerCapture(e.pointerId);
  pointerStartX = e.clientX;
  pointerLastX = e.clientX;
  pointerStartCenter = centerIndex;
  velocity = 0;
  lastMoveTs = performance.now();
});

carousel.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  const dx = e.clientX - pointerStartX;
  const dt = performance.now() - lastMoveTs;
  velocity = dt > 0 ? -((e.clientX - pointerLastX) / layout.step) * (16 / dt) : 0;
  pointerLastX = e.clientX;
  lastMoveTs = performance.now();
  centerIndex = clampCenter(pointerStartCenter - dx / layout.step);
});

function endDrag() {
  if (!dragging) return;
  dragging = false;
  carousel.classList.remove("dragging");
}
carousel.addEventListener("pointerup", endDrag);
carousel.addEventListener("pointercancel", endDrag);
carousel.addEventListener("pointerleave", endDrag);

// Wheel: horizontal scroll → carousel motion. Vertical wheel also moves it.
carousel.addEventListener("wheel", (e) => {
  e.preventDefault();
  const delta = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) / layout.step;
  centerIndex = clampCenter(centerIndex + delta);
  velocity = delta * 0.3;
}, { passive: false });

// Keyboard arrows for accessibility.
window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLElement && ["INPUT", "TEXTAREA"].includes(e.target.tagName)) return;
  if (e.key === "ArrowLeft") centerIndex = clampCenter(centerIndex - 5);
  else if (e.key === "ArrowRight") centerIndex = clampCenter(centerIndex + 5);
  else if (e.key === "Home") centerIndex = 0;
  else if (e.key === "End") centerIndex = Number(total - 1n);
  else if (e.key === "f") void findMyFace();
});

// rAF loop applies inertia and re-renders.
function tick() {
  if (!dragging && Math.abs(velocity) > 0.005) {
    centerIndex = clampCenter(centerIndex + velocity);
    velocity *= 0.92;
  }
  render();
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// Re-render on resize.
window.addEventListener("resize", () => { layout = readLayout(); });

// ----- Permalink + assignment ------------------------------------------

function parseHash(): bigint | null {
  const raw = location.hash.replace(/^#/, "");
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) return null;
  try {
    const n = BigInt(raw);
    if (n < 0n || n >= total) return null;
    return n;
  } catch {
    return null;
  }
}

function snapTo(idx: bigint, opts: { highlight?: boolean } = {}) {
  centerIndex = Number(idx);
  if (opts.highlight) assignedIndex = idx;
  positionEl.hidden = false;
  positionIndexEl.textContent = idx.toString();
}

const initialHash = parseHash();
if (initialHash !== null) {
  snapTo(initialHash);
}

// CTA: ask backend for a free slot.
const cta = document.getElementById("cta") as HTMLButtonElement;
cta.hidden = false;
cta.addEventListener("click", () => void findMyFace());

async function findMyFace() {
  cta.disabled = true;
  cta.textContent = "...";
  try {
    const res = await fetch(`${API_BASE}/api/assign`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!res.ok) throw new Error(`assign failed: ${res.status}`);
    const data = (await res.json()) as { index: string };
    snapTo(BigInt(data.index), { highlight: true });
  } catch (err) {
    console.error(err);
    cta.textContent = "try again";
    setTimeout(() => { cta.textContent = "find your face"; cta.disabled = false; }, 2000);
    return;
  }
  cta.textContent = "find your face";
  cta.disabled = false;
}

// Expose minimal API for selfie module to call.
declare global {
  interface Window {
    __zaruceSnapTo: (idx: bigint, opts?: { highlight?: boolean }) => void;
  }
}
window.__zaruceSnapTo = snapTo;
