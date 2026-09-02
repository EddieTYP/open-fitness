export const DEFAULT_TIMEZONE = "Asia/Hong_Kong";

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new RangeError("Invalid date");
  return date;
}

export function isSupportedTimeZone(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value.trim() }).format();
    return true;
  } catch {
    return false;
  }
}

export function normaliseTimeZone(value, fallback = DEFAULT_TIMEZONE) {
  return isSupportedTimeZone(value) ? value.trim() : fallback;
}

function dateTimeParts(value, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: normaliseTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(toDate(value));
  return Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

export function dateInTimeZone(value = new Date(), timeZone = DEFAULT_TIMEZONE) {
  const parts = dateTimeParts(value, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function timeInTimeZone(value = new Date(), timeZone = DEFAULT_TIMEZONE) {
  const parts = dateTimeParts(value, timeZone);
  return `${parts.hour}:${parts.minute}`;
}

export function localDateFromTimestamp(value, timeZone = DEFAULT_TIMEZONE) {
  return dateInTimeZone(value, timeZone);
}

function offsetMinutes(value, timeZone) {
  const date = toDate(value);
  const parts = dateTimeParts(date, timeZone);
  const wallClockAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return Math.round((wallClockAsUtc - date.getTime()) / 60_000);
}

function offsetText(minutes) {
  const sign = minutes >= 0 ? "+" : "-";
  const absolute = Math.abs(minutes);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}

export function timestampInTimeZone(
  value = new Date(),
  timeZone = DEFAULT_TIMEZONE,
) {
  const date = toDate(value);
  const parts = dateTimeParts(date, timeZone);
  const milliseconds = date.getUTCMilliseconds();
  const fraction = milliseconds
    ? `.${String(milliseconds).padStart(3, "0")}`
    : "";
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${fraction}${offsetText(offsetMinutes(date, timeZone))}`;
}

export function zonedDateTimeToIso(
  localDate,
  localTime,
  timeZone = DEFAULT_TIMEZONE,
) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  const timeMatch = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(localTime);
  if (!match || !timeMatch) throw new RangeError("Invalid local date or time");

  const zone = normaliseTimeZone(timeZone);
  const expected = {
    year: match[1],
    month: match[2],
    day: match[3],
    hour: timeMatch[1],
    minute: timeMatch[2],
    second: timeMatch[3] ?? "00",
  };
  const wallClockAsUtc = Date.UTC(
    Number(expected.year),
    Number(expected.month) - 1,
    Number(expected.day),
    Number(expected.hour),
    Number(expected.minute),
    Number(expected.second),
  );
  let instant = wallClockAsUtc;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    instant = wallClockAsUtc - offsetMinutes(new Date(instant), zone) * 60_000;
  }
  const resolved = dateTimeParts(new Date(instant), zone);
  if (
    Object.entries(expected).some(([key, value]) => resolved[key] !== value)
  ) {
    throw new RangeError("Local time does not exist in the selected timezone");
  }
  return timestampInTimeZone(new Date(instant), zone);
}
