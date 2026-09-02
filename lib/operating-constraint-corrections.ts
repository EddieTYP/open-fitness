import { and, desc, eq, inArray, lte } from "drizzle-orm";
import { getDb } from "@/db";
import { corrections } from "@/db/schema";
import { chunkByParameterLimit } from "@/lib/d1-limits";
import {
  normaliseOperatingConstraintStatus,
  OPERATING_CONSTRAINT_CORRECTION_FIELD,
  OPERATING_CONSTRAINT_CORRECTION_SCOPE,
  OPERATING_CONSTRAINT_STATUSES,
  projectOperatingConstraintCorrections,
} from "@/lib/operating-constraint-projection.mjs";

export {
  normaliseOperatingConstraintStatus,
  OPERATING_CONSTRAINT_CORRECTION_FIELD,
  OPERATING_CONSTRAINT_CORRECTION_SCOPE,
  OPERATING_CONSTRAINT_STATUSES,
  projectOperatingConstraintCorrections,
};

export type OperatingConstraintStatus =
  (typeof OPERATING_CONSTRAINT_STATUSES)[number];

type OperatingConstraintRow = {
  constraintId: string;
  status: string;
  effectiveDate: string;
};

type OperatingConstraintReadDb = Pick<ReturnType<typeof getDb>, "select">;

export async function effectiveOperatingConstraints<
  Constraint extends OperatingConstraintRow,
>(
  constraints: readonly Constraint[],
  asOfDate: string,
  db: OperatingConstraintReadDb = getDb(),
) {
  const targetKeys = [...new Set(constraints.map((row) => row.constraintId))];
  const matching: Array<typeof corrections.$inferSelect> = [];
  for (const targetKeyChunk of chunkByParameterLimit(targetKeys, 3)) {
    matching.push(
      ...(await db
        .select()
        .from(corrections)
        .where(
          and(
            eq(
              corrections.targetScope,
              OPERATING_CONSTRAINT_CORRECTION_SCOPE,
            ),
            eq(
              corrections.fieldName,
              OPERATING_CONSTRAINT_CORRECTION_FIELD,
            ),
            lte(corrections.effectiveDate, asOfDate),
            inArray(corrections.targetKey, targetKeyChunk),
          ),
        )
        .orderBy(
          desc(corrections.effectiveDate),
          desc(corrections.recordedAt),
          desc(corrections.correctionId),
        )),
    );
  }
  return projectOperatingConstraintCorrections(
    constraints,
    matching,
    asOfDate,
  );
}
