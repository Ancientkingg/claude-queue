import { describe, it, expect } from 'vitest';
import { parseResetTimestamp, computeSendTime } from './reset-parser';

const NOW = Date.UTC(2026, 5, 15, 12, 0, 0); // 2026-06-15T12:00:00Z

describe('parseResetTimestamp', () => {
  it('parses epoch seconds (number and string, as in the message_limit event)', () => {
    const future = Math.floor((NOW + 3_600_000) / 1000); // +1h, in seconds
    expect(parseResetTimestamp(future, NOW)).toBe(future * 1000);
    expect(parseResetTimestamp(String(future), NOW)).toBe(future * 1000);
  });

  it('parses epoch milliseconds', () => {
    const future = NOW + 3_600_000;
    expect(parseResetTimestamp(future, NOW)).toBe(future);
  });

  it('parses RFC-3339 (as returned by the /usage endpoint)', () => {
    const iso = '2026-06-15T19:00:00.000Z';
    expect(parseResetTimestamp(iso, NOW)).toBe(Date.parse(iso));
  });

  it('parses the real /usage shape (microseconds + numeric offset)', () => {
    const real = '2026-06-15T18:50:01.028967+00:00';
    const ms = parseResetTimestamp(real, NOW);
    expect(ms).not.toBeNull();
    // Truncated to ms precision; equals the seconds boundary + 28ms.
    expect(ms).toBe(Date.UTC(2026, 5, 15, 18, 50, 1, 28));
  });

  it('returns null for empty / garbage / nullish', () => {
    expect(parseResetTimestamp('', NOW)).toBeNull();
    expect(parseResetTimestamp('   ', NOW)).toBeNull();
    expect(parseResetTimestamp('not-a-date', NOW)).toBeNull();
    expect(parseResetTimestamp(null, NOW)).toBeNull();
    expect(parseResetTimestamp(undefined, NOW)).toBeNull();
  });

  it('rejects timestamps far in the past', () => {
    const longAgo = Math.floor((NOW - 48 * 3_600_000) / 1000);
    expect(parseResetTimestamp(longAgo, NOW)).toBeNull();
  });

  it('rejects timestamps absurdly far in the future', () => {
    const farFuture = Math.floor((NOW + 60 * 24 * 3_600_000) / 1000);
    expect(parseResetTimestamp(farFuture, NOW)).toBeNull();
  });
});

describe('computeSendTime', () => {
  it('adds offset + jitter to a future reset', () => {
    const reset = NOW + 3_600_000;
    const out = computeSendTime(reset, 120_000, 90_000, NOW, () => 0.5);
    expect(out).toBe(reset + 120_000 + 45_000);
  });

  it('keeps jitter within [0, max)', () => {
    const reset = NOW + 3_600_000;
    expect(computeSendTime(reset, 0, 90_000, NOW, () => 0)).toBe(reset);
    expect(computeSendTime(reset, 0, 90_000, NOW, () => 0.999999)).toBeLessThan(reset + 90_000);
  });

  it('schedules from now when the reset is already in the past', () => {
    const reset = NOW - 3_600_000;
    const out = computeSendTime(reset, 120_000, 90_000, NOW, () => 0);
    expect(out).toBe(NOW + 120_000);
  });
});
