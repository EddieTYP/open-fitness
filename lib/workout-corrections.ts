import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { corrections } from "@/db/schema";
import { chunkByParameterLimit } from "@/lib/d1-limits";
import { projectWorkoutCorrections } from "@/lib/workout-correction-projection.mjs";

export const WORKOUT_CORRECTION_TARGETS = {
  workout_session: "session_title",
  workout_set: "exercise",
} as const;

export const WORKOUT_CORRECTION_FIELDS = {
  workout_session: [
    "session_title",
    "training_phase_id",
  ],
  workout_set: ["exercise", "reps", "weight_kg_reported", "effort_raw"],
} as const;

export type WorkoutCorrection = typeof corrections.$inferSelect;

export type WorkoutReadDb = Pick<ReturnType<typeof getDb>, "select">;

type SessionRow = {
  sessionId: string;
  sessionTitle: string;
};

type SetRow = {
  setId: string;
  exercise: string;
};

async function correctionRows(
  db: WorkoutReadDb,
  targetScope: keyof typeof WORKOUT_CORRECTION_TARGETS,
  targetKeys: readonly string[],
) {
  const matching: WorkoutCorrection[] = [];
  const uniqueKeys = [...new Set(targetKeys)];
  for (const targetKeyChunk of chunkByParameterLimit(uniqueKeys, 2)) {
    const rows = await db
      .select()
      .from(corrections)
      .where(
        and(
          eq(corrections.targetScope, targetScope),
          inArray(
            corrections.fieldName,
            WORKOUT_CORRECTION_FIELDS[targetScope],
          ),
          inArray(corrections.targetKey, targetKeyChunk),
        ),
      )
      .orderBy(desc(corrections.recordedAt), desc(corrections.correctionId));
    matching.push(...rows);
  }
  return matching;
}

export async function effectiveWorkoutRecords<
  Session extends SessionRow = SessionRow,
  Set extends SetRow = SetRow,
>(
  {
    sessions = [],
    sets = [],
  }: {
    sessions?: readonly Session[];
    sets?: readonly Set[];
  },
  db: WorkoutReadDb = getDb(),
): Promise<{
  sessions: Session[];
  sets: Set[];
  appliedCorrections: WorkoutCorrection[];
}> {
  const [sessionCorrections, setCorrections] = await Promise.all([
    correctionRows(
      db,
      "workout_session",
      sessions.map((row) => row.sessionId),
    ),
    correctionRows(
      db,
      "workout_set",
      sets.map((row) => row.setId),
    ),
  ]);
  return projectWorkoutCorrections(
    { sessions, sets },
    [...sessionCorrections, ...setCorrections],
  );
}
