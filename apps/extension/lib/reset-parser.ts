/**
 * Pure helpers for turning claude.ai's rate-limit reset header into an absolute
 * send time. No DOM or browser-API dependencies — unit-tested in isolation.
 */

export interface ResetInfo {
  /** Absolute epoch milliseconds when the 5-hour usage window resets. */
  resetAtMs: number;
  /** Epoch milliseconds when this value was captured (for staleness display). */
  capturedAtMs: number;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * ONE_DAY_MS;

/**
 * Parse an `anthropic-ratelimit-unified-*-reset` header value into epoch ms.
 * Accepts epoch seconds, epoch milliseconds, or an RFC-3339 / ISO string.
 * Returns null for anything unparseable or implausible.
 */
export function parseResetHeader(
  raw: string | null | undefined,
  nowMs: number = Date.now(),
): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let ms: number | null = null;
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return null;
    // < 1e12 ⇒ epoch seconds (10-digit era); otherwise already milliseconds.
    ms = n < 1e12 ? n * 1000 : n;
  } else {
    const parsed = Date.parse(trimmed);
    ms = Number.isNaN(parsed) ? null : parsed;
  }

  if (ms == null || !Number.isFinite(ms)) return null;
  if (ms < nowMs - ONE_DAY_MS) return null;        // too far in the past
  if (ms > nowMs + THIRTY_DAYS_MS) return null;     // implausibly far ahead
  return ms;
}

/**
 * Compute the absolute send time for "end of session" mode:
 *   base (reset, or now if reset already passed) + offset + random jitter.
 */
export function computeSendTime(
  resetAtMs: number,
  offsetMs: number,
  maxJitterMs: number,
  nowMs: number = Date.now(),
  rng: () => number = Math.random,
): number {
  const base = resetAtMs > nowMs ? resetAtMs : nowMs;
  const jitter = Math.floor(rng() * Math.max(0, maxJitterMs));
  return base + Math.max(0, offsetMs) + jitter;
}
