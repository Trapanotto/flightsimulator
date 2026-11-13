/** Minutes the Swiss clock is ahead of UTC at `date` (60 in winter, 120 in summer). */
export function swissOffsetMinutes(date: Date): number {
  const y = date.getUTCFullYear();
  // Summer time runs from the last Sunday of March to the last Sunday of October, 01:00 UTC.
  const lastSunday = (month: number) => {
    const end = new Date(Date.UTC(y, month + 1, 0));
    return Date.UTC(y, month, end.getUTCDate() - end.getUTCDay(), 1);
  };
  const t = date.getTime();
  return t >= lastSunday(2) && t < lastSunday(9) ? 120 : 60;
}

/** The moment on the Swiss calendar day of `ref` when Swiss clocks show `hour` (0..24). */
export function dateAtSwissHour(ref: Date, hour: number): Date {
  const local = new Date(ref.getTime() + swissOffsetMinutes(ref) * 60_000);
  const midnightUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const guess = new Date(midnightUtc + hour * 3_600_000 - swissOffsetMinutes(ref) * 60_000);
  // Across a clock change the offset of the result differs from the reference's.
  return new Date(midnightUtc + hour * 3_600_000 - swissOffsetMinutes(guess) * 60_000);
}
