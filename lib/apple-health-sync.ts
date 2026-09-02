import {
  finiteNumber,
  isDateOnly,
  isIsoTimestamp,
  payloadSha256,
} from "./record-utils.ts";

export async function appleHealthActiveEnergyObservation(
  payload: unknown,
  today: string,
  now = new Date().toISOString(),
) {
  const keys =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? Object.keys(payload).sort().join(",")
      : "";
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    ![
      "activeEnergyKcal,localDate",
      "activeEnergyKcal,localDate,mode",
    ].includes(keys)
  ) {
    throw new Error("Invalid Apple Health sync payload");
  }

  const input = payload as {
    activeEnergyKcal: unknown;
    localDate: unknown;
    mode?: unknown;
  };
  const mode = input.mode ?? "settlement";
  if (mode !== "intraday" && mode !== "settlement") {
    throw new Error("Invalid Apple Health sync mode");
  }
  if (
    !isDateOnly(today) ||
    !isDateOnly(input.localDate) ||
    (mode === "settlement" && input.localDate >= today) ||
    (mode === "intraday" && input.localDate !== today)
  ) {
    throw new Error("Invalid Apple Health sync date");
  }
  if (mode === "intraday" && !isIsoTimestamp(now)) {
    throw new Error("Invalid Apple Health sync timestamp");
  }
  const activeEnergyKcal = finiteNumber(input.activeEnergyKcal, {
    min: 0,
    max: 10000,
  })!;
  const localDate = input.localDate;
  // Preserve the original settlement identity so existing Shortcuts and exact
  // retries remain idempotent after explicit modes are introduced.
  const digest = await payloadSha256(
    mode === "settlement"
      ? { localDate, activeEnergyKcal }
      : { mode, localDate, activeEnergyKcal },
  );
  const suffix = digest.slice(0, 16);

  return {
    mode,
    localDate,
    activeEnergyKcal,
    observedAt: mode === "intraday" ? now : null,
    status: mode === "intraday" ? "provisional" : "final",
    digest,
    id:
      mode === "settlement"
        ? `ENERGY|APPLE_HEALTH|${localDate}|${suffix}`
        : `ENERGY|APPLE_HEALTH|INTRADAY|${localDate}`,
    requestId:
      mode === "settlement"
        ? `apple-health-${localDate}-${suffix}`
        : `apple-health-intraday-${localDate}`,
  };
}
