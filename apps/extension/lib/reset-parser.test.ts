import { describe, it, expect } from 'vitest';
import { parseResetHeader, computeSendTime } from './reset-parser';

const NOW = Date.UTC(2026, 5, 15, 12, 0, 0); // 2026-06-15T12:00:00Z

describe('parseResetHeader', () => {
  it('parses epoch seconds', () => {
    const future = Math.floor((NOW + 3_600_000) / 1000); // +1h, in seconds
    expect(parseResetHeader(String(future), NOW)).toBe(future * 1000);
  });

  it('parses epoch milliseconds', () => {
    const future = NOW + 3_600_000;
    expect(parseResetHeader(String(future), NOW)).toBe(future);
  });

  it('parses RFC-3339', () => {
    const iso = '2026-06-15T19:00:00.000Z';
    expect(parseResetHeader(iso, NOW)).toBe(Date.parse(iso));
  });

  it('returns null for empty / garbage / nullish', () => {
    expect(parseResetHeader('', NOW)).toBeNull();
    expect(parseResetHeader('   ', NOW)).toBeNull();
    expect(parseResetHeader('not-a-date', NOW)).toBeNull();
    expect(parseResetHeader(null, NOW)).toBeNull();
    expect(parseResetHeader(undefined, NOW)).toBeNull();
  });

  it('rejects timestamps far in the past', () => {
    const longAgo = Math.floor((NOW - 48 * 3_600_000) / 1000);
    expect(parseResetHeader(String(longAgo), NOW)).toBeNull();
  });

  it('rejects timestamps absurdly far in the future', () => {
    const farFuture = Math.floor((NOW + 60 * 24 * 3_600_000) / 1000);
    expect(parseResetHeader(String(farFuture), NOW)).toBeNull();
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
