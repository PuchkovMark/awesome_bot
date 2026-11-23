/// <reference lib="esnext.temporal" />
export interface CalendarPeriod {
  readonly from: number;
  readonly to: number;
  readonly timezone: string;
}
export function localDay(at: number, timezone: string, offset = 0): CalendarPeriod {
  const start = Temporal.Instant.fromEpochMilliseconds(at)
    .toZonedDateTimeISO(timezone)
    .add({ days: offset })
    .startOfDay();
  return {
    from: start.epochMilliseconds,
    to: start.add({ days: 1 }).startOfDay().epochMilliseconds,
    timezone,
  };
}
