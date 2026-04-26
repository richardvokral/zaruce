/**
 * Per-IP rate limiting backed by Upstash Redis. Two windows:
 *   * short: max N (default 1) reservations per RATE_LIMIT_WINDOW_SEC (default 600)
 *   * daily: max DAILY_LIMIT (default 10) per UTC day
 *
 * Returns false when the request should be denied. Falls open in local dev
 * (no Upstash credentials) so the app stays usable without infra.
 */

import { Redis } from "@upstash/redis";

let cached: Redis | null = null;

function getRedis(): Redis | null {
  if (cached) return cached;
  const url = import.meta.env.UPSTASH_REDIS_REST_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = import.meta.env.UPSTASH_REDIS_REST_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  cached = new Redis({ url, token });
  return cached;
}

export async function checkRateLimit(ip: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return true; // dev fallback

  const window = Number(import.meta.env.RATE_LIMIT_WINDOW_SEC || process.env.RATE_LIMIT_WINDOW_SEC || "600");
  const max = Number(import.meta.env.RATE_LIMIT_MAX || process.env.RATE_LIMIT_MAX || "1");
  const dailyMax = Number(import.meta.env.DAILY_LIMIT || process.env.DAILY_LIMIT || "10");

  const today = new Date().toISOString().slice(0, 10);
  const winKey = `rl:win:${ip}`;
  const dayKey = `rl:day:${ip}:${today}`;

  const winCount = await redis.incr(winKey);
  if (winCount === 1) await redis.expire(winKey, window);
  if (winCount > max) return false;

  const dayCount = await redis.incr(dayKey);
  if (dayCount === 1) await redis.expire(dayKey, 86_400);
  if (dayCount > dailyMax) return false;

  return true;
}
