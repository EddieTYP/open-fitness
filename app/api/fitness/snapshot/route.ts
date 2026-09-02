import {
  getApiActor,
  routeError,
  unauthorizedResponse,
} from "@/lib/api-auth";
import { apiError } from "@/lib/api-error";
import { getDashboardData } from "@/lib/fitness";
import { DEFAULT_TIMEZONE } from "@/lib/timezone.mjs";

export const dynamic = "force-dynamic";
const SNAPSHOT_CONTRACT_VERSION = 6;

export async function GET(request: Request) {
  try {
    const actor = await getApiActor(request);
    if (!actor) return unauthorizedResponse();

    const venue = new URL(request.url).searchParams.get("venue")?.trim() || null;
    if (venue && venue.length > 120) {
      return apiError(
        "INVALID_SNAPSHOT_VENUE",
        400,
        { maximumLength: 120 },
        "Invalid snapshot venue",
      );
    }

    const dashboard = await getDashboardData({ planningVenue: venue });
    return Response.json(
      {
        contractVersion: SNAPSHOT_CONTRACT_VERSION,
        actor: actor.kind,
        generatedAt: new Date().toISOString(),
        timezone: dashboard.profile?.timezone ?? DEFAULT_TIMEZONE,
        dashboard,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return routeError(error);
  }
}
