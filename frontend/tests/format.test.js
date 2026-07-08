import { describe, it, expect } from 'vitest';
import { ownedFor } from '../js/app/format.js';

describe('ownedFor', () => {
  // Use local-time Date construction to avoid UTC-vs-local month boundary issues.
  const now = new Date(2026, 6, 7); // July 7, 2026 local

  it('returns "less than a month" for a date within the same month', () => {
    expect(ownedFor(new Date(2026, 6, 1), now)).toBe('less than a month');
    expect(ownedFor(new Date(2026, 6, 5), now)).toBe('less than a month');
  });

  it('crosses a calendar month boundary even if only a few days apart', () => {
    // June 20 → July 7 spans 17 days but crosses 1 calendar month boundary.
    expect(ownedFor(new Date(2026, 5, 20), now)).toBe('1m');
  });

  it('returns months-only for durations under a year', () => {
    expect(ownedFor(new Date(2026, 5, 1), now)).toBe('1m');
    expect(ownedFor(new Date(2026, 0, 1), now)).toBe('6m');
    expect(ownedFor(new Date(2025, 7, 1), now)).toBe('11m');
  });

  it('returns years-only when months component is zero', () => {
    expect(ownedFor(new Date(2025, 6, 1), now)).toBe('1y');
    expect(ownedFor(new Date(2024, 6, 1), now)).toBe('2y');
  });

  it('returns combined years and months', () => {
    expect(ownedFor(new Date(2025, 4, 1), now)).toBe('1y 2m');
    expect(ownedFor(new Date(2024, 2, 1), now)).toBe('2y 4m');
  });

  it('handles year boundary correctly', () => {
    expect(ownedFor(new Date(2025, 11, 1), now)).toBe('7m'); // Dec 2025 → Jul 2026
    expect(ownedFor(new Date(2025, 0, 1), now)).toBe('1y 6m'); // Jan 2025 → Jul 2026
  });

  it('accepts ISO date strings (parsed as UTC midnight, read in local time)', () => {
    // ISO date strings parse as UTC; the function reads local time. This test
    // documents the existing behavior — for dates far enough from month
    // boundaries that timezone offset doesn't flip the month.
    const result = ownedFor('2024-01-15', now);
    expect(result).toMatch(/^2y \d+m$/);
  });
});