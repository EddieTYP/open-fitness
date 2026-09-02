import { dateInTimeZone } from "./timezone.mjs";

export function quickMealTiming(
  localDate: string,
  timezone: string,
  now = new Date(),
) {
  if (dateInTimeZone(now, timezone) === localDate) {
    return {
      eatenAt: now.toISOString(),
      timePrecision: "exact" as const,
    };
  }

  return {
    eatenAt: null,
    timePrecision: "date_only" as const,
  };
}
