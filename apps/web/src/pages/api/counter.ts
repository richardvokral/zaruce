import type { APIRoute } from "astro";
import { currentTotalSlots } from "@zaruce/shared";
import { getDb } from "../../server/db";

export const prerender = false;

export const GET: APIRoute = async () => {
  const total = currentTotalSlots().toString();
  let occupied = "0";

  const sql = getDb();
  if (sql) {
    try {
      // Read from the denormalized counter row (kept up-to-date by the
      // AFTER INSERT trigger). Falls back to COUNT(*) on cold deploys.
      const rows = (await sql`SELECT occupied FROM slot_counter WHERE id = 1`) as Array<{ occupied: string }>;
      if (rows[0]?.occupied !== undefined) {
        occupied = String(rows[0].occupied);
      } else {
        const fallback = (await sql`SELECT COUNT(*)::text AS occupied FROM slots`) as Array<{ occupied: string }>;
        occupied = fallback[0]?.occupied ?? "0";
      }
    } catch (err) {
      console.error("counter query failed", err);
    }
  }

  return new Response(JSON.stringify({ occupied, total }), {
    headers: {
      "content-type": "application/json",
      "cache-control": "public, s-maxage=30, stale-while-revalidate=60",
    },
  });
};
