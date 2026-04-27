import type { APIRoute } from "astro";
import { currentTotalSlots, isPrebaked, prebakeAnchors } from "@zaruce/shared";
import { getDb } from "../../../server/db";

export const prerender = false;

/**
 * Server-side probe used by /admin. Each sub-check is wrapped in a per-probe
 * timeout so a hung Modal cold-start can't kill the whole serverless function
 * (Vercel caps at 10s Hobby / 60s Pro). Probes return partial results with
 * timing info so the admin page can show what worked and what didn't.
 *
 * Auth: Bearer ADMIN_TOKEN. Same token the Modal admin endpoints check.
 */

interface ProbeRequest {
  slot?: number;
  modalTimeoutMs?: number;
}

interface StepLog {
  step: string;
  ms: number;
  ok: boolean;
  note?: string;
}

const env = (key: string): string =>
  ((import.meta.env as Record<string, string | undefined>)[key] ??
    process.env[key] ??
    "").trim();

function mask(value: string): string {
  if (!value) return "";
  if (value.length <= 6) return "*".repeat(value.length);
  return `${value.slice(0, 3)}…${value.slice(-2)} (len ${value.length})`;
}

/** Race a fetch against a timeout — never hang the serverless function. */
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    return { res, elapsedMs: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

async function timed<T>(label: string, fn: () => Promise<T>, log: StepLog[]): Promise<T> {
  const start = Date.now();
  try {
    const out = await fn();
    const ok = !!(out as { ok?: boolean }).ok;
    log.push({ step: label, ms: Date.now() - start, ok });
    return out;
  } catch (err) {
    log.push({ step: label, ms: Date.now() - start, ok: false, note: (err as Error).message });
    throw err;
  }
}

async function probeModalFace(base: string, slot: number, timeoutMs: number) {
  if (!base) return { ok: false, reason: "MODAL_FACE_BASE not set", skipped: true };
  const url = `${base.replace(/\/$/, "")}/?slot=${slot}`;
  try {
    const { res, elapsedMs } = await fetchWithTimeout(url, { redirect: "manual" }, timeoutMs);
    const contentType = res.headers.get("content-type") ?? "";
    const contentLength = res.headers.get("content-length") ?? "";
    let bodySnippet = "";
    if (!contentType.startsWith("image/")) {
      try {
        const text = await res.text();
        bodySnippet = text.slice(0, 400);
      } catch (e) {
        bodySnippet = `<could not read body: ${(e as Error).message}>`;
      }
    }
    return {
      ok: res.ok && contentType.startsWith("image/"),
      url,
      status: res.status,
      contentType,
      contentLength,
      elapsedMs,
      bodySnippet,
    };
  } catch (err) {
    const msg = (err as Error).message || String(err);
    return {
      ok: false,
      url,
      error: msg,
      timedOut: msg.toLowerCase().includes("abort"),
      timeoutMs,
    };
  }
}

async function probeModalAdmin(base: string, token: string, timeoutMs: number) {
  if (!base) return { ok: false, reason: "MODAL_ADMIN_STATUS_BASE not set", skipped: true };
  const url = `${base.replace(/\/$/, "")}/?authorization=${encodeURIComponent(`Bearer ${token}`)}`;
  const redactedUrl = url.replace(/authorization=[^&]+/, "authorization=REDACTED");
  try {
    const { res, elapsedMs } = await fetchWithTimeout(url, {}, timeoutMs);
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { /* not json */ }
    return {
      ok: res.ok,
      status: res.status,
      url: redactedUrl,
      elapsedMs,
      body: parsed ?? text.slice(0, 400),
    };
  } catch (err) {
    return { ok: false, url: redactedUrl, error: (err as Error).message };
  }
}

/**
 * Replicate the /api/face/<id> redirect logic locally instead of HTTP-calling
 * our own deployment. Vercel serverless self-fetches sometimes fail with a
 * generic "fetch failed" at the runtime level (SSL/edge timing), which would
 * mask the real config we're trying to inspect.
 */
function probeFaceRedirect(
  slot: number,
  modalFaceBase: string,
  modalStaticFaceBase: string,
) {
  const total = currentTotalSlots();
  if (slot < 0 || BigInt(slot) >= total) {
    return { ok: false, status: 404, reason: "slot out of range", computed: true };
  }
  const inWindow = isPrebaked(BigInt(slot));
  const staticBase = modalStaticFaceBase.replace(/\/$/, "");
  const gpuBase = modalFaceBase.replace(/\/$/, "");

  // Mirror /api/face/[id].ts: prefer static for in-window slots when configured.
  if (inWindow && staticBase) {
    return {
      ok: true,
      status: 302,
      route: "static",
      inWindow,
      location: `${staticBase}/?slot=${slot}`,
      computed: true,
    };
  }
  if (!gpuBase) {
    return {
      ok: false,
      status: 404,
      route: inWindow ? "static-but-base-missing" : "gpu-but-base-missing",
      inWindow,
      reason: "neither MODAL_STATIC_FACE_BASE (in-window) nor MODAL_FACE_BASE (out-of-window) configured",
      computed: true,
    };
  }
  return {
    ok: true,
    status: 302,
    route: "gpu",
    inWindow,
    location: `${gpuBase}/?slot=${slot}`,
    computed: true,
    note: inWindow
      ? "MODAL_STATIC_FACE_BASE not set, in-window slot falls through to GPU."
      : "Slot is outside any pre-baked window; routed to GPU as expected.",
  };
}

/**
 * Hit the static_face Modal endpoint with a known in-window slot to verify
 * the prebake volume actually contains JPEGs. A 404 here is the smoking gun
 * for "I deployed the prebake routing but never ran prebake_entrypoint".
 */
async function probeStaticFace(base: string, timeoutMs: number) {
  if (!base) return { ok: false, reason: "MODAL_STATIC_FACE_BASE not set", skipped: true };
  // First slot of the first pre-baked window — guaranteed to exist if prebake ran.
  const probeSlot = Number(prebakeAnchors()[0]);
  const url = `${base.replace(/\/$/, "")}/?slot=${probeSlot}`;
  try {
    const { res, elapsedMs } = await fetchWithTimeout(url, {}, timeoutMs);
    const contentType = res.headers.get("content-type") ?? "";
    let bodySnippet = "";
    if (!contentType.startsWith("image/")) {
      try { bodySnippet = (await res.text()).slice(0, 400); } catch { /* */ }
    }
    return {
      ok: res.ok && contentType.startsWith("image/"),
      url,
      status: res.status,
      contentType,
      contentLength: res.headers.get("content-length") ?? "",
      elapsedMs,
      probeSlot,
      bodySnippet,
      hint: !res.ok && res.status === 404
        ? "404 means the prebake volume has no JPEG for this slot — run `modal run services/face-generator/main.py::prebake_entrypoint` from the codespace."
        : undefined,
    };
  } catch (err) {
    return { ok: false, url, error: (err as Error).message };
  }
}

/**
 * Replicate the /api/counter logic against the same DB so we report on the
 * same data path without an HTTP self-call.
 */
async function probeCounterLocal(timeoutMs: number) {
  const total = currentTotalSlots().toString();
  const sql = getDb();
  if (!sql) {
    return {
      ok: true,
      computed: true,
      body: { occupied: "0", total },
      note: "DATABASE_URL not set; matches the production fall-through behavior in /api/counter.ts",
    };
  }
  const start = Date.now();
  try {
    const rows = await Promise.race([
      sql`SELECT occupied FROM slot_counter WHERE id = 1` as unknown as Promise<Array<{ occupied: string }>>,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`counter query timeout after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
    return {
      ok: true,
      computed: true,
      elapsedMs: Date.now() - start,
      body: { occupied: rows[0]?.occupied ?? "0", total },
    };
  } catch (err) {
    return { ok: false, computed: true, elapsedMs: Date.now() - start, error: (err as Error).message };
  }
}

async function probeDb(timeoutMs: number) {
  const sql = getDb();
  if (!sql) return { ok: false, reason: "DATABASE_URL not set", skipped: true };
  const start = Date.now();
  try {
    const result = await Promise.race([
      sql`SELECT 1 AS one` as unknown as Promise<Array<{ one: number }>>,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`db timeout after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
    return { ok: result[0]?.one === 1, elapsedMs: Date.now() - start };
  } catch (err) {
    return { ok: false, error: (err as Error).message, elapsedMs: Date.now() - start };
  }
}

export const POST: APIRoute = async ({ request, url }) => {
  const expected = env("ADMIN_TOKEN");
  const got = request.headers.get("authorization");
  if (!expected) {
    return new Response(JSON.stringify({ error: "ADMIN_TOKEN not configured on server" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }
  if (got !== `Bearer ${expected}`) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  let payload: ProbeRequest = {};
  try {
    payload = (await request.json()) as ProbeRequest;
  } catch { /* empty body is fine */ }
  const slot = Number.isFinite(payload.slot) && (payload.slot ?? -1) >= 0 ? payload.slot! : 12345;
  // Per-probe budget. Total worst case ≈ 5 × this. Default 6s keeps us under
  // the 10s Hobby cap with margin; bump via the `modalTimeoutMs` param if you
  // want to wait through a Modal cold-start.
  const probeTimeoutMs = Number.isFinite(payload.modalTimeoutMs) && (payload.modalTimeoutMs ?? 0) > 0
    ? Math.min(Math.max(payload.modalTimeoutMs!, 1000), 55_000)
    : 6_000;

  const origin = url.origin;
  const modalFaceBase = env("MODAL_FACE_BASE");
  const modalStaticFaceBase = env("MODAL_STATIC_FACE_BASE");
  const modalAdminBase = env("MODAL_ADMIN_STATUS_BASE");

  const log: StepLog[] = [];
  const overallStart = Date.now();

  console.log(`[admin/diagnostics] start slot=${slot} timeout=${probeTimeoutMs}ms origin=${origin}`);

  const envFlags = {
    DATABASE_URL: { set: !!env("DATABASE_URL"), preview: mask(env("DATABASE_URL")) },
    UPSTASH_REDIS_REST_URL: { set: !!env("UPSTASH_REDIS_REST_URL"), preview: mask(env("UPSTASH_REDIS_REST_URL")) },
    UPSTASH_REDIS_REST_TOKEN: { set: !!env("UPSTASH_REDIS_REST_TOKEN"), preview: mask(env("UPSTASH_REDIS_REST_TOKEN")) },
    SEED_SALT: { set: !!env("SEED_SALT"), preview: mask(env("SEED_SALT")) },
    VISITOR_HASH_KEY: { set: !!env("VISITOR_HASH_KEY"), preview: mask(env("VISITOR_HASH_KEY")) },
    ADMIN_TOKEN: { set: !!env("ADMIN_TOKEN"), preview: mask(env("ADMIN_TOKEN")) },
    MODAL_FACE_BASE: { set: !!modalFaceBase, preview: modalFaceBase || "" },
    MODAL_STATIC_FACE_BASE: { set: !!modalStaticFaceBase, preview: modalStaticFaceBase || "" },
    MODAL_ADMIN_STATUS_BASE: { set: !!modalAdminBase, preview: modalAdminBase || "" },
    PUBLIC_FACE_BASE: { set: !!env("PUBLIC_FACE_BASE"), preview: env("PUBLIC_FACE_BASE") || "" },
    PUBLIC_API_BASE: { set: !!env("PUBLIC_API_BASE"), preview: env("PUBLIC_API_BASE") || "" },
  };

  // Run probes in parallel but each guarded by its own timeout. Promise.allSettled
  // ensures one probe failing doesn't lose the others.
  const settled = await Promise.allSettled([
    timed("faceRedirect", async () => probeFaceRedirect(slot, modalFaceBase, modalStaticFaceBase), log),
    timed("modalFace", () => probeModalFace(modalFaceBase, slot, probeTimeoutMs), log),
    timed("modalStaticFace", () => probeStaticFace(modalStaticFaceBase, probeTimeoutMs), log),
    timed("modalAdmin", () => probeModalAdmin(modalAdminBase, expected, probeTimeoutMs), log),
    timed("db", () => probeDb(probeTimeoutMs), log),
    timed("counter", () => probeCounterLocal(probeTimeoutMs), log),
  ]);

  const get = <T>(i: number, fallback: T): T =>
    settled[i]!.status === "fulfilled"
      ? (settled[i] as PromiseFulfilledResult<T>).value
      : fallback;

  const result = {
    slot,
    origin,
    probeTimeoutMs,
    totalElapsedMs: Date.now() - overallStart,
    env: envFlags,
    faceRedirect: get(0, { ok: false, error: "probe crashed" }),
    modalFace: get(1, { ok: false, error: "probe crashed" }),
    modalStaticFace: get(2, { ok: false, error: "probe crashed" }),
    modalAdmin: get(3, { ok: false, error: "probe crashed" }),
    db: get(4, { ok: false, error: "probe crashed" }),
    counter: get(5, { ok: false, error: "probe crashed" }),
    log,
    note: "If modalStaticFace is 404, the prebake volume is empty — run `modal run services/face-generator/main.py::prebake_entrypoint` from the codespace. Pass {modalTimeoutMs: 30000} in the request body to give Modal cold-starts more time.",
  };

  console.log(`[admin/diagnostics] done in ${result.totalElapsedMs}ms`, log);

  return new Response(JSON.stringify(result, null, 2), {
    headers: { "content-type": "application/json" },
  });
};
