import type { APIRoute } from "astro";
import { currentTotalSlots, isPrebaked } from "@zaruce/shared";

export const prerender = false;

const env = (key: string): string =>
  ((import.meta.env as Record<string, string | undefined>)[key] ??
    process.env[key] ??
    "").trim().replace(/\/$/, "");

/**
 * Routes a face request to the cheapest backend that can serve it:
 *
 *   - In-window slot + MODAL_STATIC_FACE_BASE configured → 302 to the
 *     static_face Modal endpoint (CPU-only, ~free, Cloudflare-cached).
 *   - Anything else with MODAL_FACE_BASE configured → 302 to the GPU
 *     /face endpoint (one cold-start per fresh slot, expensive).
 *   - Neither configured → 503.
 *
 * We never proxy the bytes through this Vercel function — egress is paid
 * by Modal and CDN-fronted, so a 302 + immutable cache header keeps cost
 * out of our serverless budget.
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

  const bucket = url.searchParams.get("bucket");
  const staticBase = env("MODAL_STATIC_FACE_BASE");
  const gpuBase = env("MODAL_FACE_BASE");

  // Prefer the static (pre-baked) endpoint for in-window slots. The bucket
  // parameter is only meaningful for the GPU path (it changes the seed),
  // so when a request carries a bucket we must hit the GPU even if the slot
  // happens to fall in a window.
  if (!bucket && staticBase && isPrebaked(index)) {
    return redirect(`${staticBase}/?slot=${index.toString()}`);
  }

  if (!gpuBase) {
    // Outside any window and no GPU backend configured — return 404 so the
    // carousel keeps the silhouette fallback visible without paying for
    // anything. This is the "scrolled past the pre-baked window" case.
    return new Response("not pre-baked", { status: 404 });
  }

  const target = `${gpuBase}/?slot=${index.toString()}${bucket ? `&bucket=${bucket}` : ""}`;
  return redirect(target);
};

function redirect(target: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location: target,
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
