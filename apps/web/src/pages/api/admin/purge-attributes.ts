import type { APIRoute } from "astro";
import { getDb } from "../../../server/db";

export const prerender = false;

/**
 * Daily Vercel Cron target. Calls the Postgres function that nulls
 * attribute_bucket_id for slots past their retention boundary (PRD §11).
 *
 * Auth: Bearer ADMIN_TOKEN. Vercel Cron sends the configured Authorization
 * header automatically; the same token is reused for the Modal admin routes.
 */
export const POST: APIRoute = async ({ request }) => {
  const expected = import.meta.env.ADMIN_TOKEN || process.env.ADMIN_TOKEN;
  const got = request.headers.get("authorization");
  if (!expected || got !== `Bearer ${expected}`) {
    return new Response("unauthorized", { status: 401 });
  }

  const sql = getDb();
  if (!sql) return new Response("db unavailable", { status: 503 });

  try {
    const rows = (await sql`SELECT purge_expired_attributes() AS purged`) as Array<{ purged: number }>;
    return new Response(JSON.stringify({ purged: rows[0]?.purged ?? 0 }), {
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    console.error("purge failed", err);
    return new Response("db error", { status: 500 });
  }
};
