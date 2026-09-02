import assert from "node:assert/strict";
import test from "node:test";

import {
  dateInTimeZone,
  isSupportedTimeZone,
  localDateFromTimestamp,
  normaliseTimeZone,
  timestampInTimeZone,
  zonedDateTimeToIso,
} from "../lib/timezone.mjs";

test("profile timezone validation accepts IANA zones", () => {
  assert.equal(isSupportedTimeZone("Asia/Tokyo"), true);
  assert.equal(isSupportedTimeZone("Not/A_Zone"), false);
  assert.equal(normaliseTimeZone("Not/A_Zone"), "Asia/Hong_Kong");
});

test("calendar dates follow the selected timezone", () => {
  const instant = "2026-08-07T01:30:00Z";
  assert.equal(dateInTimeZone(instant, "Asia/Tokyo"), "2026-08-07");
  assert.equal(localDateFromTimestamp(instant, "America/Los_Angeles"), "2026-08-06");
});

test("calendar dates remain stable across daylight-saving transitions", () => {
  assert.equal(
    localDateFromTimestamp("2026-03-08T06:59:00Z", "America/New_York"),
    "2026-03-08",
  );
  assert.equal(
    localDateFromTimestamp("2026-03-08T07:01:00Z", "America/New_York"),
    "2026-03-08",
  );
  assert.equal(
    localDateFromTimestamp("2026-11-01T05:30:00Z", "America/New_York"),
    "2026-11-01",
  );
  assert.equal(
    localDateFromTimestamp("2026-11-01T06:30:00Z", "America/New_York"),
    "2026-11-01",
  );
});

test("wall-clock timestamps use the selected zone and DST offset", () => {
  assert.equal(
    zonedDateTimeToIso("2026-08-07", "09:15", "America/New_York"),
    "2026-08-07T09:15:00-04:00",
  );
  assert.equal(
    timestampInTimeZone("2026-12-07T14:15:00Z", "America/New_York"),
    "2026-12-07T09:15:00-05:00",
  );
});

test("nonexistent DST wall times are rejected", () => {
  assert.throws(
    () => zonedDateTimeToIso("2026-03-08", "02:30", "America/New_York"),
    /does not exist/,
  );
});
