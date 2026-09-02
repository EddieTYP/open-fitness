import packageJson from "@/package.json";
import {
  getLocalClient,
  getLocalDbRuntimeStatus,
} from "@/db/local-sqlite";

export const dynamic = "force-dynamic";

const RESPONSE_HEADERS = {
  "Cache-Control": "private, no-store",
  "Content-Type": "application/json",
};

const RELEASE_ID_PATTERN = /^[0-9a-f]{40}$/;

export function GET() {
  const releaseId = process.env.FITNESS_RELEASE_ID;
  try {
    if (!releaseId || !RELEASE_ID_PATTERN.test(releaseId)) {
      throw new Error("Runtime release identity is unavailable");
    }
    getLocalClient();
    const database = getLocalDbRuntimeStatus();
    if (!database) throw new Error("Database is not initialized");

    return Response.json(
      {
        status: "ready",
        ready: true,
        appVersion: packageJson.version,
        releaseId,
        schemaVersion: database.schemaVersion,
      },
      { headers: RESPONSE_HEADERS },
    );
  } catch {
    return Response.json(
      {
        status: "not_ready",
        ready: false,
        appVersion: packageJson.version,
        releaseId:
          releaseId && RELEASE_ID_PATTERN.test(releaseId) ? releaseId : null,
        schemaVersion: null,
      },
      { status: 503, headers: RESPONSE_HEADERS },
    );
  }
}
