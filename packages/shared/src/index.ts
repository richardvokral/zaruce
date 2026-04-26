/**
 * Total-slot count is not static. The PRD frames "one face per person on
 * Earth" — Earth's population grows roughly 0.84 %/year (UN medium estimate),
 * so we model it as a deterministic monotonic function of the current date.
 *
 * Baseline anchored at 2026-04-26 = 8 289 468 500. Daily increment derived
 * from the annual rate so that one full year reproduces the projected total.
 */

export const POPULATION_BASELINE = 8_289_468_500n;
export const BASELINE_EPOCH_MS = Date.UTC(2026, 3, 26); // 2026-04-26 UTC, month is 0-indexed
export const ANNUAL_GROWTH_RATE = 0.0084;
export const DAILY_INCREMENT: bigint = 190_718n; // floor(BASELINE * 0.0084 / 365)

/** Deterministic per-day total: same value for every request on a given UTC day. */
export function currentTotalSlots(now: Date = new Date()): bigint {
  const days = Math.max(0, Math.floor((now.getTime() - BASELINE_EPOCH_MS) / 86_400_000));
  return POPULATION_BASELINE + DAILY_INCREMENT * BigInt(days);
}

export type SlotIndex = bigint;

export interface AssignmentResponse {
  index: string;
  attributeBucketId: number | null;
  createdAt: string;
}

export interface CounterResponse {
  occupied: string;
  total: string;
}

export * from "./seed.js";
export * from "./attributes.js";
