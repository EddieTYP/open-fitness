import {
  assertNutritionExportTokenIsolation,
  getApiActor,
  unauthorizedResponse,
} from "@/lib/api-auth";
import { resolveAutomationActor } from "@/lib/api-auth-policy";
import { apiError } from "@/lib/api-error";
import {
  NutritionExportQueryError,
  nutritionExportPage,
} from "@/lib/nutrition-export";
import { getRuntimeEnvValue } from "@/lib/runtime-env";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  let response: Response;
  try {
    const token = getRuntimeEnvValue("FITNESS_NUTRITION_EXPORT_TOKEN");
    const sourceId = getRuntimeEnvValue("FITNESS_NUTRITION_EXPORT_SOURCE_ID");
    assertNutritionExportTokenIsolation();
    if (!token || !sourceId) {
      throw new Error("Nutrition export configuration unavailable");
    }
    const actor = resolveAutomationActor(request, { apiToken: token })
      ?? await getApiActor(request);
    response = actor
      ? Response.json(await nutritionExportPage(
        new URL(request.url).searchParams, sourceId, token,
      ))
      : unauthorizedResponse();
  } catch (error) {
    response = error instanceof NutritionExportQueryError
      ? apiError("INVALID_NUTRITION_EXPORT_QUERY", 400)
      : apiError("INTERNAL_ERROR", 500);
  }
  response.headers.set("cache-control", "no-store");
  return response;
}
