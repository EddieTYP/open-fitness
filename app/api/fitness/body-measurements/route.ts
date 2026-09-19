import { getDb } from "@/db";
import { auditLog, bodyMeasurements, corrections } from "@/db/schema";
import { and, asc, desc, eq, gte, lt, lte, sql } from "drizzle-orm";
import {
  getApiActor,
  routeError,
  unauthorizedResponse,
  type ApiActor,
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

// The local SQLite adapter must not open overlapping write transactions.
let measurementWriteInFlight = false;

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

const correctionNumberFields = {
  weightKg: { min: 20, max: 350 },
  bmi: { min: 5, max: 80 },
  bodyFatPct: { min: 0, max: 100 },
  visceralFatRating: { min: 0, max: 100 },
  muscleMassKg: { min: 0, max: 250 },
  boneMassKg: { min: 0, max: 20 },
  metabolicAgeYears: { min: 1, max: 150 },
  bodyWaterPct: { min: 0, max: 100 },
  physiqueRating: { min: 1, max: 9 },
  heartRateBpm: { min: 0, max: 250 },
  ...enrichmentNumberFields,
} as const;

type MeasurementSnapshot = {
  measurement: ReturnType<typeof measurementResponse>;
  revision: string;
};

async function latestMeasurementCorrection(
  db: Pick<ReturnType<typeof getDb>, "select">,
  measurementId: string,
) {
  const rows = await db.select().from(corrections).where(and(
    eq(corrections.targetScope, "body_measurement"),
    eq(corrections.targetKey, measurementId),
    eq(corrections.fieldName, "measurement"),
  )).orderBy(desc(corrections.recordedAt)).limit(1);
  return rows[0] ?? null;
}

function measurementRevision(
  measurement: ReturnType<typeof measurementResponse>,
  correctionId: string | null,
) {
  return payloadSha256({ measurement, correctionId });
}

async function correctMeasurement(
  request: Request,
  payload: Record<string, unknown>,
  actor: ApiActor,
) {
  const allowed = new Set(["action", "measurementId", "expectedRevision", "reason", "values"]);
  const { measurementId, expectedRevision, reason, values: rawValues } = payload;
  if (
    Object.keys(payload).some((key) => !allowed.has(key)) ||
    typeof measurementId !== "string" || !measurementId.trim() ||
    typeof expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(expectedRevision) ||
    typeof reason !== "string" || !reason.trim() ||
    !rawValues || typeof rawValues !== "object" || Array.isArray(rawValues) ||
    !Object.keys(rawValues).length
  ) {
    return apiError("INVALID_BODY_MEASUREMENT_CORRECTION", 400);
  }
  const id = measurementId.trim();
  const values: Partial<Record<keyof typeof correctionNumberFields, number | null>> = {};
  for (const [field, value] of Object.entries(rawValues)) {
    if (!Object.prototype.hasOwnProperty.call(correctionNumberFields, field)) {
      return apiError("INVALID_BODY_MEASUREMENT_CORRECTION", 400, { field });
    }
    const key = field as keyof typeof correctionNumberFields;
    const range = correctionNumberFields[key];
    if (
      value === null ? key === "weightKg" :
      typeof value !== "number" || !Number.isFinite(value) || value < range.min || value > range.max
    ) {
      return apiError("INVALID_BODY_MEASUREMENT_CORRECTION", 400, { field });
    }
    values[key] = value as number | null;
  }
  const idempotencyKey = request.headers.get("x-idempotency-key")?.trim();
  if (!idempotencyKey || !/^[A-Za-z0-9._:-]{8,200}$/.test(idempotencyKey)) {
    return apiError("IDEMPOTENCY_KEY_REQUIRED", 400);
  }
  const digest = await payloadSha256(payload);
  const correctionId = `BODY-CORRECTION|${idempotencyKey}`;
  const timezone = await getProfileTimezone();
  const stored = await getDb().transaction(async (tx) => {
    const replayedId = await findIdempotentReplay(idempotencyKey, "body_measurement", digest, tx);
    if (replayedId) {
      const rows = await tx.select().from(corrections)
        .where(eq(corrections.correctionId, correctionId)).limit(1);
      if (!rows[0]?.correctedValue || replayedId !== id) {
        throw new Error("Body measurement correction receipt is unavailable");
      }
      return { ...JSON.parse(rows[0].correctedValue) as MeasurementSnapshot, replay: true };
    }
    const rows = await tx.select().from(bodyMeasurements)
      .where(eq(bodyMeasurements.measurementId, id)).limit(1);
    const current = rows[0];
    if (!current) return null;
    const latest = await latestMeasurementCorrection(tx, id);
    const before = measurementResponse(current);
    const revision = await measurementRevision(before, latest?.correctionId ?? null);
    if (revision !== expectedRevision) throw new Error("BODY_MEASUREMENT_REVISION_CONFLICT");
    const weightKg = values.weightKg ?? current.weightKg;
    const bodyFatPct = values.bodyFatPct === undefined ? current.bodyFatPct : values.bodyFatPct;
    const updated = await tx.update(bodyMeasurements).set({
      ...values,
      weightKg,
      fatMassKg: bodyFatPct === null ? null : rounded(weightKg * (bodyFatPct / 100)),
      estimatedFatFreeMassKg: bodyFatPct === null ? null : rounded(weightKg * (1 - bodyFatPct / 100)),
    }).where(eq(bodyMeasurements.measurementId, id)).returning();
    const measurement = measurementResponse(updated[0]);
    const result: MeasurementSnapshot = {
      measurement,
      revision: await measurementRevision(measurement, correctionId),
    };
    // Keep the existing correction table's timestamp natural key monotonic.
    const recordedAt = new Date(Math.max(Date.now(), latest ? Date.parse(latest.recordedAt) + 1 : 0)).toISOString();
    await tx.insert(corrections).values({
      correctionId,
      effectiveDate: current.localDate ?? localDateFromTimestamp(current.measuredAt, timezone),
      targetScope: "body_measurement",
      targetKey: id,
      fieldName: "measurement",
      originalValue: JSON.stringify({ measurement: before, revision }),
      correctedValue: JSON.stringify(result),
      reason: reason.trim(),
      source: actor.id,
      recordedAt,
    });
    await tx.insert(auditLog).values({
      requestId: idempotencyKey,
      actor: actor.id,
      operation: "correct",
      entityType: "body_measurement",
      entityId: id,
      payloadSha256: digest,
    });
    return { ...result, replay: false };
  });
  if (!stored) return apiError("BODY_MEASUREMENT_NOT_FOUND", 404, { measurementId: id });
  return Response.json({ ...stored, correctionId, requestId: idempotencyKey });
}

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
    const measurement = measurementResponse(rows[0]);
    const latestCorrection = await latestMeasurementCorrection(getDb(), measurementId);
    return Response.json({
      measurement,
      revision: await measurementRevision(measurement, latestCorrection?.correctionId ?? null),
      latestCorrection: latestCorrection ? {
        correctionId: latestCorrection.correctionId,
        reason: latestCorrection.reason,
        recordedAt: latestCorrection.recordedAt,
        before: JSON.parse(latestCorrection.originalValue!) as MeasurementSnapshot,
        after: JSON.parse(latestCorrection.correctedValue!) as MeasurementSnapshot,
      } : null,
      trend: await measurementTrend(rows[0]),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return routeError(error);
  }
}

export async function PATCH(request: Request) {
  let ownsWrite = false;
  try {
    const actor = await getApiActor(request);
    if (!actor) return unauthorizedResponse();
    if (measurementWriteInFlight) return apiError("BODY_MEASUREMENT_WRITE_CONFLICT", 409);
    measurementWriteInFlight = true;
    ownsWrite = true;
    const rawPayload = await request.json();
    if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
      return apiError("INVALID_BODY_MEASUREMENT_ENRICHMENT", 400);
    }
    if (rawPayload.action === "correct") {
      return await correctMeasurement(request, rawPayload, actor);
    }
    if (rawPayload.action !== undefined && rawPayload.action !== "enrich") {
      return apiError("INVALID_BODY_MEASUREMENT_ACTION", 400);
    }
    const payload = rawPayload as BodyMeasurementEnrichmentInput;
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
      const databaseCode = (error as Error & { code?: string }).code;
      if (databaseCode === "SQLITE_BUSY" || databaseCode === "SQLITE_BUSY_SNAPSHOT") {
        return apiError("BODY_MEASUREMENT_WRITE_CONFLICT", 409);
      }
      if (error.message === "BODY_MEASUREMENT_REVISION_CONFLICT") {
        return apiError("BODY_MEASUREMENT_REVISION_CONFLICT", 409);
      }
      if (error.message === "BODY_MEASUREMENT_CREATED_AT_CONFLICT") {
        return measurementConflict("createdAt");
      }
      if (error.message.startsWith("BODY_MEASUREMENT_FIELD_CONFLICT:")) {
        return measurementConflict(error.message.split(":", 2)[1] || "unknown");
      }
    }
    return routeError(error);
  } finally {
    if (ownsWrite) measurementWriteInFlight = false;
  }
}

export async function POST(request: Request) {
  let ownsWrite = false;
  try {
    const actor = await getApiActor(request);
    if (!actor) return unauthorizedResponse();
    if (measurementWriteInFlight) return apiError("BODY_MEASUREMENT_WRITE_CONFLICT", 409);
    measurementWriteInFlight = true;
    ownsWrite = true;

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
  } finally {
    if (ownsWrite) measurementWriteInFlight = false;
  }
}
