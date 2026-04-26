import type { APIRoute } from "astro";
import { currentTotalSlots, TOTAL_BUCKETS } from "@zaruce/shared";
import { getDb } from "../../server/db";
import { checkRateLimit } from "../../server/rate-limit";
import { clientIp, toBytea, visitorHash } from "../../server/visitor";

export const prerender = false;

interface AssignBody {
  attributeBucketId?: number;
}

export const POST: APIRoute = async ({ request }) => {
  const ip = clientIp(request);
  const ua = request.headers.get("user-agent") ?? "";

  if (!(await checkRateLimit(ip))) {
    return json({ error: "rate_limited" }, 429);
  }

  const body = await safeJson<AssignBody>(request);
  let bucketId: number | null = null;
  if (typeof body.attributeBucketId === "number") {
    if (
      !Number.isInteger(body.attributeBucketId) ||
      body.attributeBucketId < 0 ||
      body.attributeBucketId >= TOTAL_BUCKETS
    ) {
      return json({ error: "invalid_bucket" }, 400);
    }
    bucketId = body.attributeBucketId;
  }

  const total = currentTotalSlots();
  const hash = await visitorHash(ip, ua);

  const sql = getDb();
  if (!sql) {
    // Local dev fallback: no DB, just return a random index.
    return json({
      index: randomBigInt(total).toString(),
      attributeBucketId: bucketId,
      createdAt: new Date().toISOString(),
    });
  }

  const retentionDays = Number(
    import.meta.env.ATTRIBUTE_RETENTION_DAYS ||
      process.env.ATTRIBUTE_RETENTION_DAYS ||
      "90",
  );
  const purgeAt = bucketId !== null
    ? new Date(Date.now() + retentionDays * 86_400_000).toISOString()
    : null;
  const hashLiteral = toBytea(hash);

  // Try a handful of random indices. At <1% occupancy a collision is rare;
  // the upper bound just keeps us from spinning forever in the catastrophic
  // case where someone has filled most of the table.
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = randomBigInt(total);
    try {
      const rows = (await sql`
        INSERT INTO slots (index, visitor_hash, attribute_bucket_id, attributes_purge_at)
        VALUES (${candidate.toString()}::bigint, ${hashLiteral}::bytea, ${bucketId}, ${purgeAt})
        ON CONFLICT (index) DO NOTHING
        RETURNING index::text AS index, created_at
      `) as Array<{ index: string; created_at: string }>;
      const row = rows[0];
      if (row) {
        return json({
          index: row.index,
          attributeBucketId: bucketId,
          createdAt: row.created_at,
        });
      }
    } catch (err) {
      console.error("slot insert failed", err);
      return json({ error: "database_error" }, 500);
    }
  }

  return json({ error: "no_free_slot" }, 503);
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function safeJson<T>(request: Request): Promise<Partial<T>> {
  try {
    if (!request.headers.get("content-type")?.includes("application/json")) return {};
    return (await request.json()) as Partial<T>;
  } catch {
    return {};
  }
}

function randomBigInt(maxExclusive: bigint): bigint {
  const buf = new BigUint64Array(1);
  crypto.getRandomValues(buf);
  return buf[0]! % maxExclusive;
}
