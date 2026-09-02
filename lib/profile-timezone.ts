import { getDb } from "@/db";
import { profile } from "@/db/schema";
import { normaliseTimeZone } from "@/lib/timezone.mjs";

export async function getProfileTimezone() {
  const rows = await getDb()
    .select({ timezone: profile.timezone })
    .from(profile)
    .limit(1);
  return normaliseTimeZone(rows[0]?.timezone);
}
