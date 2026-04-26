import type { APIRoute } from "astro";
import { getDb } from "../../../server/db";

export const prerender = false;

/**
 * Server-side probe used by /admin. Checks:
 *   - Which env vars are set (booleans only, never values)
 *   - What URL /api/face/<id> would redirect to (without following it)
 *   - Modal /face endpoint reachability (HEAD-style: status, content-type, length)
 *   - Modal admin-status endpoint payload
 *   - DB connectivity (SELECT 1)
 *   - Local /api/counter response
 *
 * Auth: Bearer ADMIN_TOKEN. Same token the Modal admin endpoints check.
 */

interface ProbeRequest {
  slot?: number;
}

const env = (key: string): string =>
  // import.meta.env wins at build time on Vercel; process.env covers Node runtime.
  ((import.meta.env as Record<string, string | undefined>)[key] ??
    process.env[key] ??
    "").trim();

function mask(value: string): string {
  if (!value) return "";
  if (value.length <= 6) return "*".repeat(value.length);
  return `${value.slice(0, 3)}…${value.slice(-2)} (len ${value.length})`;
}

async function probeModalFace(base: string, slot: number) {
  if (!base) return { ok: false, reason: "MODAL_FACE_BASE not set" };
  const url = `${base.replace(/\/$/, "")}/?slot=${slot}`;
  const start = Date.now();
  try {
    const res = await fetch(url, { redirect: "manual" });
    const elapsed = Date.now() - start;
    const contentType = res.headers.get("content-type") ?? "";
    const contentLength = res.headers.get("content-length") ?? "";
    let bodySnippet = "";
    if (!contentType.startsWith("image/")) {
      const text = await res.text();
      bodySnippet = text.slice(0, 400);
    }
    return {
      ok: res.ok && contentType.startsWith("image/"),
      url,
      status: res.status,
      contentType,
      contentLength,
      elapsedMs: elapsed,
      bodySnippet,
    };
  } catch (err) {
    return { ok: false, url, error: (err as Error).message };
  }
}

async function probeModalAdmin(base: string, token: string) {
  if (!base) return { ok: false, reason: "MODAL_ADMIN_STATUS_BASE not set" };
  const url = `${base.replace(/\/$/, "")}/?authorization=${encodeURIComponent(`Bearer ${token}`)}`;
  try {
    const res = await fetch(url);
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { /* not json */ }
    return {
      ok: res.ok,
      status: res.status,
      url: url.replace(/authorization=[^&]+/, "authorization=REDACTED"),
      body: parsed ?? text.slice(0, 400),
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

async function probeFaceRedirect(origin: string, slot: number) {
  const url = `${origin}/api/face/${slot}.jpg`;
  try {
    const res = await fetch(url, { redirect: "manual" });
    return {
      ok: res.status === 302,
      status: res.status,
      location: res.headers.get("location") ?? "",
      cacheControl: res.headers.get("cache-control") ?? "",
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

async function probeLocalCounter(origin: string) {
  const url = `${origin}/api/counter`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { /* */ }
    return { ok: res.ok, status: res.status, body: parsed ?? text.slice(0, 200) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

async function probeDb() {
  const sql = getDb();
  if (!sql) return { ok: false, reason: "DATABASE_URL not set" };
  try {
    const rows = (await sql`SELECT 1 AS one`) as Array<{ one: number }>;
    return { ok: rows[0]?.one === 1, rows };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
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

  const origin = url.origin;
  const modalFaceBase = env("MODAL_FACE_BASE");
  const modalAdminBase = env("MODAL_ADMIN_STATUS_BASE");

  const envFlags = {
    DATABASE_URL: { set: !!env("DATABASE_URL"), preview: mask(env("DATABASE_URL")) },
    UPSTASH_REDIS_REST_URL: { set: !!env("UPSTASH_REDIS_REST_URL"), preview: mask(env("UPSTASH_REDIS_REST_URL")) },
    UPSTASH_REDIS_REST_TOKEN: { set: !!env("UPSTASH_REDIS_REST_TOKEN"), preview: mask(env("UPSTASH_REDIS_REST_TOKEN")) },
    SEED_SALT: { set: !!env("SEED_SALT"), preview: mask(env("SEED_SALT")) },
    VISITOR_HASH_KEY: { set: !!env("VISITOR_HASH_KEY"), preview: mask(env("VISITOR_HASH_KEY")) },
    ADMIN_TOKEN: { set: !!env("ADMIN_TOKEN"), preview: mask(env("ADMIN_TOKEN")) },
    MODAL_FACE_BASE: { set: !!modalFaceBase, preview: modalFaceBase || "" },
    MODAL_ADMIN_STATUS_BASE: { set: !!modalAdminBase, preview: modalAdminBase || "" },
    PUBLIC_FACE_BASE: { set: !!env("PUBLIC_FACE_BASE"), preview: env("PUBLIC_FACE_BASE") || "" },
    PUBLIC_API_BASE: { set: !!env("PUBLIC_API_BASE"), preview: env("PUBLIC_API_BASE") || "" },
  };

  const [faceRedirect, modalFace, modalAdmin, db, counter] = await Promise.all([
    probeFaceRedirect(origin, slot),
    probeModalFace(modalFaceBase, slot),
    probeModalAdmin(modalAdminBase, expected),
    probeDb(),
    probeLocalCounter(origin),
  ]);

  return new Response(JSON.stringify({
    slot,
    origin,
    env: envFlags,
    faceRedirect,
    modalFace,
    modalAdmin,
    db,
    counter,
    note: "Set MODAL_ADMIN_STATUS_BASE in Vercel to enable the Modal admin probe (e.g. https://richard-vokral--admin-status.modal.run).",
  }, null, 2), {
    headers: { "content-type": "application/json" },
  });
};
