import {
  getLocalClient,
  getLocalDbRuntimeStatus,
} from "@/db/local-sqlite";
import {
  getApiActor,
  routeError,
  unauthorizedResponse,
} from "@/lib/api-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const actor = await getApiActor(request);
    if (!actor) return unauthorizedResponse();

    getLocalClient();
    const database = getLocalDbRuntimeStatus();
    return Response.json(
      {
        actor: actor.kind,
        mode: "disabled",
        status: database ? "ready" : "not_ready",
        schemaVersion: database?.schemaVersion ?? null,
      },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return routeError(error);
  }
}
