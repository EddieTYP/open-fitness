import { sql } from "drizzle-orm";
import {
  getApiActor,
  routeError,
  unauthorizedResponse,
} from "@/lib/api-auth";
import { getDb } from "@/db";
import { getProfileTimezone } from "@/lib/profile-timezone";
import { dateInTimeZone } from "@/lib/timezone.mjs";

export const dynamic = "force-dynamic";

type RevisionRow = {
  todayRevision: number | null;
  progressRevision: number | null;
  nutritionRevision: number | null;
  nutritionEnergyRevision: string | null;
};

export async function GET(request: Request) {
  try {
    const actor = await getApiActor(request);
    if (!actor) return unauthorizedResponse();

    const timezone = await getProfileTimezone();

  const rows = await getDb().all<RevisionRow>(sql`
    SELECT
      MAX(CASE
        WHEN entity_type IN (
          'workout_session',
          'session_note',
          'training_schedule_event',
          'training_exercise_selection',
          'training_routine_template',
          'profile',
          'correction'
        )
        THEN audit_id
      END) AS "todayRevision",
      MAX(CASE
        WHEN entity_type IN (
          'body_measurement',
          'workout_session',
          'session_note',
          'profile',
          'correction'
        )
        THEN audit_id
      END) AS "progressRevision",
      MAX(CASE
        WHEN entity_type IN (
          'body_measurement',
          'nutrition_food',
          'nutrition_combo',
          'nutrition_energy',
          'nutrition_meal',
          'nutrition_plan',
          'nutrition_target',
          'profile',
          'correction'
        )
        THEN audit_id
      END) AS "nutritionRevision",
      (
        SELECT MAX(observed_at)
        FROM nutrition_energy_observations
      ) AS "nutritionEnergyRevision"
    FROM audit_log
  `);
  const revisions = rows[0] ?? {
    todayRevision: null,
    progressRevision: null,
    nutritionRevision: null,
    nutritionEnergyRevision: null,
  };

    return Response.json(
      {
        generatedAt: new Date().toISOString(),
        revisions: {
          today: `${dateInTimeZone(new Date(), timezone)}:${revisions.todayRevision ?? 0}`,
          progress: String(revisions.progressRevision ?? 0),
          nutrition: `${revisions.nutritionRevision ?? 0}:${revisions.nutritionEnergyRevision ?? ""}`,
        },
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return routeError(error);
  }
}
