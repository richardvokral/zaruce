/**
 * Opaque, non-reversible visitor hash derived from request headers.
 * Used as the only PII-adjacent data we persist alongside a slot reservation.
 */

const encoder = new TextEncoder();

export async function visitorHash(ip: string, ua: string): Promise<Uint8Array> {
  const key = import.meta.env.VISITOR_HASH_KEY || process.env.VISITOR_HASH_KEY || "dev-key";
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(`${ip}|${ua}`));
  return new Uint8Array(sig);
}

export function clientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "0.0.0.0"
  );
}

export function toBytea(bytes: Uint8Array): string {
  // Postgres BYTEA literal in `\x...` form, accepted by the Neon driver.
  return "\\x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
