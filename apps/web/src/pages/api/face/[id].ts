import type { APIRoute } from "astro";
import { currentTotalSlots } from "@zaruce/shared";

export const prerender = false;

/**
 * Redirects to Modal for the actual face JPEG. We send a 302 so Vercel doesn't
 * egress the bytes through our Functions; Cloudflare/Modal own caching.
 *
 * If MODAL_FACE_BASE is unset we 404 — visible "empty slot" placeholder is
 * what the carousel renders by default, so this is not a critical error.
 */
export const GET: APIRoute = async ({ params, url }) => {
  const raw = (params.id ?? "").replace(/\.jpg$/, "");
  if (!/^\d+$/.test(raw)) return new Response("not found", { status: 404 });

  let index: bigint;
  try {
    index = BigInt(raw);
  } catch {
    return new Response("not found", { status: 404 });
  }
  if (index < 0n || index >= currentTotalSlots()) {
    return new Response("not found", { status: 404 });
  }

  const base = (
    import.meta.env.MODAL_FACE_BASE ||
    process.env.MODAL_FACE_BASE ||
    ""
  ).replace(/\/$/, "");
  if (!base) return new Response("face backend not configured", { status: 503 });

  // Forward the optional `bucket` query parameter so the selfie flow can pin
  // the seed to its lookup bucket without leaking it into the slot URL.
  const bucket = url.searchParams.get("bucket");
  const target = `${base}/?slot=${index.toString()}${bucket ? `&bucket=${bucket}` : ""}`;

  return new Response(null, {
    status: 302,
    headers: {
      location: target,
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
};
