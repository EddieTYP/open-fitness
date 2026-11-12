import { resolveApiActor, type ResolvedApiActor } from "@/lib/api-auth-policy";
import { ApiActorResolutionError } from "@/lib/api-route-error";
import { readOwnerAuthEnvironment } from "@/lib/owner-auth-env.mjs";
import { getRuntimeEnvValue } from "@/lib/runtime-env";

export {
  ApiActorResolutionError,
  routeError,
  unauthorizedResponse,
} from "@/lib/api-route-error";

export type ApiActor = ResolvedApiActor;

export function assertNutritionExportTokenIsolation() {
  const token = getRuntimeEnvValue("FITNESS_NUTRITION_EXPORT_TOKEN");
  if (token && [
    "FITNESS_API_TOKEN",
    "FITNESS_HEALTH_SYNC_TOKEN",
    "FITNESS_SESSION_SECRET",
    "FITNESS_OWNER_PASSWORD_HASH",
  ].some((key) => token === getRuntimeEnvValue(key))) {
    throw new Error("Nutrition export token must be independent");
  }
}

export async function getApiActor(request: Request): Promise<ApiActor | null> {
  try {
    assertNutritionExportTokenIsolation();
    const ownerEnvironment = readOwnerAuthEnvironment();
    return resolveApiActor(request, {
      apiToken: getRuntimeEnvValue("FITNESS_API_TOKEN") ?? undefined,
      nodeEnv: ownerEnvironment.nodeEnv,
      allowLocalPreview:
        getRuntimeEnvValue("FITNESS_ALLOW_LOCAL_PREVIEW") === "1",
      ownerPasswordHash: ownerEnvironment.passwordHash ?? undefined,
      ownerSessionSecret: ownerEnvironment.sessionSecret ?? undefined,
      ownerPublicOrigin: ownerEnvironment.publicOrigin ?? undefined,
    });
  } catch (error) {
    throw new ApiActorResolutionError(error);
  }
}
