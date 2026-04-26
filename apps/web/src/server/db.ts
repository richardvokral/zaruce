/**
 * Neon serverless connection. The driver works in Edge and Node runtimes; we
 * lazily instantiate so endpoints can run without DATABASE_URL during local
 * development (they fall back to mock responses).
 */

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

let cached: NeonQueryFunction<false, false> | null = null;

export function getDb(): NeonQueryFunction<false, false> | null {
  const url = import.meta.env.DATABASE_URL || process.env.DATABASE_URL;
  if (!url) return null;
  if (!cached) {
    cached = neon(url);
  }
  return cached;
}
