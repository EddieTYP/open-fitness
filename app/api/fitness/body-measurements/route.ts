import { getDb } from "@/db";
import { auditLog, bodyMeasurements } from "@/db/schema";
import { and, asc, desc, eq, gte, lt, lte, sql } from "drizzle-orm";
import {
  getApiActor,
  routeError,
  unauthorizedResponse,
} from "@/lib/api-auth";
import { apiError } from "@/lib/api-error";
import {
  finiteNumber,
  isIsoTimestamp,
  payloadSha256,
  requestId,
} from "@/lib/record-utils";
import { findIdempotentReplay } from "@/lib/idempotency";
import { getProfileTimezone } from "@/lib/profile-timezone";
import { localDateFromTimestamp } from "@/lib/timezone.mjs";

export const dynamic = "force-dynamic";

type BodyMeasurementInput = {
  measurementId?: string;
  measuredAt?: string;
  sourceDevice?: string;
  source?: string;
  sourceFile?: string;
  weightKg?: number;
  bmi?: number | null;
  bodyFatPct?: number | null;
  visceralFatRating?: number | null;
  muscleMassKg?: number | null;
  muscleQuality?: number | null;
  boneMassKg?: number | null;
  bmrKcalPerDay?: number | null;
  metabolicAgeYears?: number | null;
  bodyWaterPct?: number | null;
  physiqueRating?: number | null;
  muscleMassRightArmKg?: number | null;
  muscleMassLeftArmKg?: number | null;
  muscleMassRightLegKg?: number | null;
  muscleMassLeftLegKg?: number | null;
  muscleMassTrunkKg?: number | null;
  muscleQualityRightArm?: number | null;
  muscleQualityLeftArm?: number | null;
  muscleQualityRightLeg?: number | null;
  muscleQualityLeftLeg?: number | null;
  muscleQualityTrunk?: number | null;
  bodyFatRightArmPct?: number | null;
  bodyFatLeftArmPct?: number | null;
  bodyFatRightLegPct?: number | null;
  bodyFatLeftLegPct?: number | null;
  bodyFatTrunkPct?: number | null;
  heartRateBpm?: number | null;
};

function measurementResponse(
  measurement: typeof bodyMeasurements.$inferSelect,
) {
  const { sourceFile, ...values } = measurement;
  return { ...values, source: sourceFile };
}

const trendFields = [
  "weightKg",
  "bodyFatPct",
  "muscleMassKg",
  "bodyWaterPct",
  "visceralFatRating",
] as const;

type TrendMeasurement = Pick<
  typeof bodyMeasurements.$inferSelect,
  | "measurementId"
  | "measuredAt"
  | "localDate"
  | "sourceDevice"
  | (typeof trendFields)[number]
>;

function dateOffset(localDate: string, days: number) {
  const date = new Date(`${localDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function rounded(value: number) {
  return Math.round(value * 1000) / 1000;
}

function trendValues(row: TrendMeasurement) {
  return Object.fromEntries(trendFields.map((field) => [field, row[field]]));
}

function metricDelta(
  first: TrendMeasurement | null,
  latest: TrendMeasurement | null,
) {
  if (!first || !latest) return {};
  return Object.fromEntries(
    trendFields.flatMap((field) => {
      const start = first[field];
      const end = latest[field];
      return typeof start === "number" && typeof end === "number"
        ? [[field, rounded(end - start)]]
        : [];
    }),
  );
}

function metricAverages(rows: TrendMeasurement[]) {
  return Object.fromEntries(
    trendFields.flatMap((field) => {
      const values = rows
        .map((row) => row[field])
        .filter((value): value is number => typeof value === "number");
      return values.length
        ? [[field, rounded(values.reduce((sum, value) => sum + value, 0) / values.length)]]
        : [];
    }),
  );
}

async function measurementTrend(anchor: TrendMeasurement) {
  const db = getDb();
  const measuredInstant = sql<number>`julianday(${bodyMeasurements.measuredAt})`;
  const anchorInstant = sql<number>`julianday(${anchor.measuredAt})`;
  const previousRows = await db
    .select()
    .from(bodyMeasurements)
    .where(
      and(
        eq(bodyMeasurements.sourceDevice, anchor.sourceDevice),
        lt(measuredInstant, anchorInstant),
      ),
    )
    .orderBy(desc(measuredInstant), desc(bodyMeasurements.measurementId))
    .limit(1);
  const previous = previousRows[0] ?? null;

  if (!anchor.localDate) {
    return {
      sourceDevice: anchor.sourceDevice,
      previous: previous
        ? {
            measurementId: previous.measurementId,
            measuredAt: previous.measuredAt,
            localDate: previous.localDate,
            values: trendValues(previous),
          }
        : null,
      deltaFromPrevious: metricDelta(previous, anchor),
      sevenDay: {
        sampleCount: 0,
        dateRange: null,
        sufficient: false,
        averages: {},
        firstToLatestChange: {},
      },
    };
  }

  const from = dateOffset(anchor.localDate, -6);
  const rows = await db
    .select()
    .from(bodyMeasurements)
    .where(
      and(
        eq(bodyMeasurements.sourceDevice, anchor.sourceDevice),
        gte(bodyMeasurements.localDate, from),
        lte(bodyMeasurements.localDate, anchor.localDate),
        lte(measuredInstant, anchorInstant),
      ),
    )
    .orderBy(
      asc(bodyMeasurements.localDate),
      desc(measuredInstant),
      desc(bodyMeasurements.measurementId),
    );
  const byDate = new Map<string, TrendMeasurement>();
  for (const row of rows) {
    if (row.localDate && !byDate.has(row.localDate)) byDate.set(row.localDate, row);
  }
  const samples = [...byDate.values()];
  const first = samples[0] ?? null;
  const latest = samples.at(-1) ?? null;

  return {
    sourceDevice: anchor.sourceDevice,
    previous: previous
      ? {
          measurementId: previous.measurementId,
          measuredAt: previous.measuredAt,
          localDate: previous.localDate,
          values: trendValues(previous),
        }
      : null,
    deltaFromPrevious: metricDelta(previous, anchor),
    sevenDay: {
      sampleCount: samples.length,
      dateRange: samples.length
        ? { from: first!.localDate, to: latest!.localDate }
        : null,
      sufficient: samples.length >= 3,
      averages: metricAverages(samples),
      firstToLatestChange: metricDelta(first, latest),
    },
  };
}

type BodyMeasurementEnrichmentInput = {
  measurementId?: string;
  expectedCreatedAt?: string;
  values?: Partial<BodyMeasurementInput>;
};

const enrichmentNumberFields = {
  muscleQuality: { min: 0, max: 200 },
  bmrKcalPerDay: { min: 500, max: 6000 },
  muscleMassRightArmKg: { min: 0, max: 30 },
  muscleMassLeftArmKg: { min: 0, max: 30 },
  muscleMassRightLegKg: { min: 0, max: 80 },
  muscleMassLeftLegKg: { min: 0, max: 80 },
  muscleMassTrunkKg: { min: 0, max: 150 },
  muscleQualityRightArm: { min: 0, max: 200 },
  muscleQualityLeftArm: { min: 0, max: 200 },
  muscleQualityRightLeg: { min: 0, max: 200 },
  muscleQualityLeftLeg: { min: 0, max: 200 },
  muscleQualityTrunk: { min: 0, max: 200 },
  bodyFatRightArmPct: { min: 0, max: 100 },
  bodyFatLeftArmPct: { min: 0, max: 100 },
  bodyFatRightLegPct: { min: 0, max: 100 },
  bodyFatLeftLegPct: { min: 0, max: 100 },
  bodyFatTrunkPct: { min: 0, max: 100 },
} as const;

function measurementConflict(field: string) {
  return apiError(
    "BODY_MEASUREMENT_CONFLICT",
    409,
    { field },
    "Body measurement changed before enrichment",
  );
}

export async function GET(request: Request) {
  try {
    const actor = await getApiActor(request);
    if (!actor) return unauthorizedResponse();
    const measurementId = new URL(request.url).searchParams
      .get("measurementId")
      ?.trim();
    if (!measurementId) {
      return apiError(
        "MEASUREMENT_ID_REQUIRED",
        400,
        { field: "measurementId" },
        "measurementId is required",
      );
    }
    const rows = await getDb()
      .select()
      .from(bodyMeasurements)
      .where(eq(bodyMeasurements.measurementId, measurementId))
      .limit(1);
    if (!rows[0]) {
      return apiError(
        "BODY_MEASUREMENT_NOT_FOUND",
        404,
        { measurementId },
        "Body measurement not found",
      );
    }
    return Response.json({
      measurement: measurementResponse(rows[0]),
      trend: await measurementTrend(rows[0]),
    });
  } catch (error) {
    return routeError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const actor = await getApiActor(request);
    if (!actor) return unauthorizedResponse();
    const payload = (await request.json()) as BodyMeasurementEnrichmentInput;
    const measurementId = payload.measurementId?.trim();
    const expectedCreatedAt = payload.expectedCreatedAt?.trim();
    const rawValues = payload.values;
    if (!measurementId || !expectedCreatedAt || !rawValues) {
      return apiError(
        "INVALID_BODY_MEASUREMENT_ENRICHMENT",
        400,
        {},
        "measurementId, expectedCreatedAt, and values are required",
      );
    }

    const values: Record<string, string | number> = {};
    const sourceDevice = rawValues.sourceDevice?.trim();
    if (sourceDevice) values.sourceDevice = sourceDevice;
    const source = rawValues.source?.trim() || rawValues.sourceFile?.trim();
    if (source) values.sourceFile = source;
    for (const [field, range] of Object.entries(enrichmentNumberFields)) {
      if (!Object.prototype.hasOwnProperty.call(rawValues, field)) continue;
      const value = finiteNumber(
        rawValues[field as keyof BodyMeasurementInput],
        { ...range, optional: true },
      );
      if (value === null) {
        return apiError(
          "INVALID_BODY_MEASUREMENT_ENRICHMENT",
          400,
          { field },
          `${field} must be a number`,
        );
      }
      values[field] = value;
    }
    const allowed = new Set([
      "sourceDevice",
      "source",
      "sourceFile",
      ...Object.keys(enrichmentNumberFields),
    ]);
    const extraFields = Object.keys(rawValues).filter((field) => !allowed.has(field));
    if (extraFields.length || !Object.keys(values).length) {
      return apiError(
        "INVALID_BODY_MEASUREMENT_ENRICHMENT",
        400,
        { fields: extraFields },
        "Enrichment contains unsupported or empty values",
      );
    }

    const idempotencyKey = requestId(request);
    const digest = await payloadSha256(payload);
    const db = getDb();
    const replayedId = await findIdempotentReplay(
      idempotencyKey,
      "body_measurement",
      digest,
    );
    if (replayedId) {
      const replayedRows = await db
        .select()
        .from(bodyMeasurements)
        .where(eq(bodyMeasurements.measurementId, replayedId))
        .limit(1);
      if (!replayedRows[0]) {
        throw new Error("Body measurement enrichment replay is unavailable");
      }
      return Response.json({
        measurement: measurementResponse(replayedRows[0]),
        requestId: idempotencyKey,
        replay: true,
      });
    }
    const stored = await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(bodyMeasurements)
        .where(eq(bodyMeasurements.measurementId, measurementId))
        .limit(1);
      const current = rows[0];
      if (!current) return null;
      if (current.createdAt !== expectedCreatedAt) {
        throw new Error("BODY_MEASUREMENT_CREATED_AT_CONFLICT");
      }
      const update: Record<string, string | number> = {};
      for (const [field, value] of Object.entries(values)) {
        const currentValue = current[field as keyof typeof current];
        const fillable =
          currentValue === null ||
          (field === "sourceDevice" && currentValue === "Manual entry") ||
          (field === "sourceFile" && currentValue === "Open Fitness WebApp");
        if (!fillable && currentValue !== value) {
          throw new Error(`BODY_MEASUREMENT_FIELD_CONFLICT:${field}`);
        }
        if (fillable) update[field] = value;
      }
      if (Object.keys(update).length) {
        await tx
          .update(bodyMeasurements)
          .set(update)
          .where(eq(bodyMeasurements.measurementId, measurementId));
      }
      await tx.insert(auditLog).values({
        requestId: idempotencyKey,
        actor: actor.id,
        operation: "enrich",
        entityType: "body_measurement",
        entityId: measurementId,
        payloadSha256: digest,
      });
      const updatedRows = await tx
        .select()
        .from(bodyMeasurements)
        .where(eq(bodyMeasurements.measurementId, measurementId))
        .limit(1);
      return updatedRows[0] ?? null;
    });
    if (!stored) {
      return apiError(
        "BODY_MEASUREMENT_NOT_FOUND",
        404,
        { measurementId },
        "Body measurement not found",
      );
    }
    return Response.json({
      measurement: measurementResponse(stored),
      requestId: idempotencyKey,
    });
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "BODY_MEASUREMENT_CREATED_AT_CONFLICT") {
        return measurementConflict("createdAt");
      }
      if (error.message.startsWith("BODY_MEASUREMENT_FIELD_CONFLICT:")) {
        return measurementConflict(error.message.split(":", 2)[1] || "unknown");
      }
    }
    return routeError(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await getApiActor(request);
    if (!actor) return unauthorizedResponse();

    const payload = (await request.json()) as BodyMeasurementInput;
    if (!isIsoTimestamp(payload.measuredAt)) {
      return apiError(
        "INVALID_MEASUREMENT_TIMESTAMP",
        400,
        { field: "measuredAt" },
        "Invalid measurement timestamp",
      );
    }

    const weightKg = finiteNumber(payload.weightKg, { min: 20, max: 350 });
    const bodyFatPct = finiteNumber(payload.bodyFatPct, {
      min: 0,
      max: 100,
      optional: true,
    });
    const id =
      payload.measurementId?.trim() || `WEB-MANUAL|${payload.measuredAt}`;
    const idempotencyKey = requestId(request);
    const digest = await payloadSha256(payload);
    const db = getDb();
    const replayedId = await findIdempotentReplay(
      idempotencyKey,
      "body_measurement",
      digest,
    );
    if (replayedId) {
      return Response.json({
        measurementId: replayedId,
        requestId: idempotencyKey,
        replay: true,
      });
    }

    const timezone = await getProfileTimezone();
    const localDate = localDateFromTimestamp(payload.measuredAt, timezone);

    const insertMeasurement = db.insert(bodyMeasurements).values({
      measurementId: id,
      measuredAt: payload.measuredAt,
      localDate,
      sourceDevice: payload.sourceDevice?.trim() || "Manual entry",
      sourceFile:
        payload.source?.trim() ||
        payload.sourceFile?.trim() ||
        "Open Fitness WebApp",
      weightKg: weightKg!,
      bmi: finiteNumber(payload.bmi, { min: 5, max: 80, optional: true }),
      bodyFatPct,
      visceralFatRating: finiteNumber(payload.visceralFatRating, {
        min: 0,
        max: 100,
        optional: true,
      }),
      muscleMassKg: finiteNumber(payload.muscleMassKg, {
        min: 0,
        max: 250,
        optional: true,
      }),
      muscleQuality: finiteNumber(payload.muscleQuality, {
        min: 0,
        max: 200,
        optional: true,
      }),
      boneMassKg: finiteNumber(payload.boneMassKg, {
        min: 0,
        max: 20,
        optional: true,
      }),
      bmrKcalPerDay: finiteNumber(payload.bmrKcalPerDay, {
        min: 500,
        max: 6000,
        optional: true,
      }),
      metabolicAgeYears: finiteNumber(payload.metabolicAgeYears, {
        min: 1,
        max: 150,
        optional: true,
      }),
      bodyWaterPct: finiteNumber(payload.bodyWaterPct, {
        min: 0,
        max: 100,
        optional: true,
      }),
      physiqueRating: finiteNumber(payload.physiqueRating, {
        min: 1,
        max: 9,
        optional: true,
      }),
      muscleMassRightArmKg: finiteNumber(payload.muscleMassRightArmKg, {
        min: 0,
        max: 30,
        optional: true,
      }),
      muscleMassLeftArmKg: finiteNumber(payload.muscleMassLeftArmKg, {
        min: 0,
        max: 30,
        optional: true,
      }),
      muscleMassRightLegKg: finiteNumber(payload.muscleMassRightLegKg, {
        min: 0,
        max: 80,
        optional: true,
      }),
      muscleMassLeftLegKg: finiteNumber(payload.muscleMassLeftLegKg, {
        min: 0,
        max: 80,
        optional: true,
      }),
      muscleMassTrunkKg: finiteNumber(payload.muscleMassTrunkKg, {
        min: 0,
        max: 150,
        optional: true,
      }),
      muscleQualityRightArm: finiteNumber(payload.muscleQualityRightArm, {
        min: 0,
        max: 200,
        optional: true,
      }),
      muscleQualityLeftArm: finiteNumber(payload.muscleQualityLeftArm, {
        min: 0,
        max: 200,
        optional: true,
      }),
      muscleQualityRightLeg: finiteNumber(payload.muscleQualityRightLeg, {
        min: 0,
        max: 200,
        optional: true,
      }),
      muscleQualityLeftLeg: finiteNumber(payload.muscleQualityLeftLeg, {
        min: 0,
        max: 200,
        optional: true,
      }),
      muscleQualityTrunk: finiteNumber(payload.muscleQualityTrunk, {
        min: 0,
        max: 200,
        optional: true,
      }),
      bodyFatRightArmPct: finiteNumber(payload.bodyFatRightArmPct, {
        min: 0,
        max: 100,
        optional: true,
      }),
      bodyFatLeftArmPct: finiteNumber(payload.bodyFatLeftArmPct, {
        min: 0,
        max: 100,
        optional: true,
      }),
      bodyFatRightLegPct: finiteNumber(payload.bodyFatRightLegPct, {
        min: 0,
        max: 100,
        optional: true,
      }),
      bodyFatLeftLegPct: finiteNumber(payload.bodyFatLeftLegPct, {
        min: 0,
        max: 100,
        optional: true,
      }),
      bodyFatTrunkPct: finiteNumber(payload.bodyFatTrunkPct, {
        min: 0,
        max: 100,
        optional: true,
      }),
      heartRateBpm: finiteNumber(payload.heartRateBpm, {
        min: 0,
        max: 250,
        optional: true,
      }),
      fatMassKg:
        bodyFatPct === null
          ? null
          : Math.round(weightKg! * (bodyFatPct / 100) * 1000) / 1000,
      estimatedFatFreeMassKg:
        bodyFatPct === null
          ? null
          : Math.round(weightKg! * (1 - bodyFatPct / 100) * 1000) / 1000,
    });

    const insertAudit = db.insert(auditLog).values({
      requestId: idempotencyKey,
      actor: actor.id,
      operation: "insert",
      entityType: "body_measurement",
      entityId: id,
      payloadSha256: digest,
    });

    await db.batch([insertMeasurement, insertAudit]);
    return Response.json(
      { measurementId: id, requestId: idempotencyKey },
      { status: 201 },
    );
  } catch (error) {
    return routeError(error);
  }
}
