import {
  getApiActor,
  routeError,
  unauthorizedResponse,
} from "@/lib/api-auth";
import { apiError } from "@/lib/api-error";
import { getNutritionDay } from "@/lib/nutrition";
import { getProfileTimezone } from "@/lib/profile-timezone";
import { isDateOnly } from "@/lib/record-utils";
import { dateInTimeZone } from "@/lib/timezone.mjs";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const actor = await getApiActor(request);
    if (!actor) return unauthorizedResponse();

    const timezone = await getProfileTimezone();
    const url = new URL(request.url);
    const requestedDate =
      url.searchParams.get("date") || dateInTimeZone(new Date(), timezone);
    if (!isDateOnly(requestedDate)) {
      return apiError(
        "INVALID_NUTRITION_DATE",
        400,
        { field: "date" },
        "Invalid nutrition date",
      );
    }

    const nutrition = await getNutritionDay(requestedDate);
    return Response.json(
      {
        actor: actor.kind,
        generatedAt: new Date().toISOString(),
        timezone,
        nutrition,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return routeError(error);
  }
}
