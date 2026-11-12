import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { and, asc, eq, gte, inArray, isNull, lte, min } from "drizzle-orm";
import { LibSQLDatabase } from "drizzle-orm/libsql";
import { LibSQLSession } from "drizzle-orm/libsql/session";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core";
import { getLocalClient } from "@/db/local-sqlite";
import {
  nutritionMeals as meals,
  nutritionMealRevisions as revisions,
  nutritionMealItems as items,
  profile,
} from "@/db/schema";
import { chunkByParameterLimit } from "@/lib/d1-limits";
import { isDateOnly } from "@/lib/record-utils";
import { dateInTimeZone, isSupportedTimeZone } from "@/lib/timezone.mjs";

export const exportNutrients = [
  "energyKcal",
  "proteinG",
  "totalFatG",
  "saturatedFatG",
  "transFatG",
  "carbsG",
  "sugarG",
  "fibreG",
  "sodiumMg",
  "cholesterolMg",
] as const;

export class NutritionExportQueryError extends Error {}

function invalid(): never {
  throw new NutritionExportQueryError("Invalid nutrition export query");
}

export function shiftExportDate(date: string, days: number) {
  const instant = new Date(`${date}T00:00:00Z`);
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

type Cursor = {
  version: 1;
  source: string;
  timezone: string;
  startDate: string;
  endDate: string;
  nextDate: string;
  limit: number;
};

function signature(body: string, secret: string) {
  return createHmac("sha256", secret).update(body).digest();
}

function encodeCursor(cursor: Cursor, secret: string) {
  const body = Buffer.from(JSON.stringify(cursor)).toString("base64url");
  return `${body}.${signature(body, secret).toString("base64url")}`;
}

function decodeCursor(value: string, secret: string): Cursor {
  if (value.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) {
    invalid();
  }
  const [body, mac] = value.split(".");
  const supplied = Buffer.from(mac, "base64url");
  const expected = signature(body, secret);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    invalid();
  }
  try {
    const cursor = JSON.parse(Buffer.from(body, "base64url").toString()) as Cursor;
    if (
      cursor.version !== 1 ||
      !isDateOnly(cursor.startDate) ||
      !isDateOnly(cursor.endDate) ||
      !isDateOnly(cursor.nextDate) ||
      cursor.startDate > cursor.nextDate ||
      cursor.nextDate > cursor.endDate ||
      !Number.isInteger(cursor.limit) ||
      cursor.limit < 1 || cursor.limit > 90
    ) {
      invalid();
    }
    return cursor;
  } catch {
    return invalid();
  }
}

export async function nutritionExportPage(
  params: URLSearchParams,
  sourceId: string,
  secret: string,
  now = new Date(),
) {
  const allowed = ["date", "startDate", "endDate", "limit", "cursor"];
  for (const key of params.keys()) {
    if (!allowed.includes(key) || params.getAll(key).length !== 1) {
      invalid();
    }
  }
  if (params.has("cursor") && params.size !== 1) {
    invalid();
  }
  const client = getLocalClient();
  const transaction = await client.transaction("read");
  try {
    // The installed drizzle factory accepts Client only; its session binds a read transaction.
    const dialect = new SQLiteAsyncDialect();
    const session = new LibSQLSession(client, dialect, undefined, {}, transaction);
    const db = new LibSQLDatabase("async", dialect, session, undefined);
    const profiles = await db
      .select({ profileId: profile.profileId, timezone: profile.timezone })
      .from(profile).limit(2);
    if (profiles.length !== 1 || !isSupportedTimeZone(profiles[0].timezone)) {
      throw new Error("Nutrition export profile unavailable");
    }
    const { profileId, timezone } = profiles[0];
    const source = `open-fitness:${digest([sourceId, profileId])}`;
    const yesterday = shiftExportDate(dateInTimeZone(now, timezone), -1);
    let selection: Cursor;
    if (params.has("cursor")) {
      selection = decodeCursor(params.get("cursor")!, secret);
      if (selection.source !== source || selection.timezone !== timezone || selection.endDate > yesterday) {
        invalid();
      }
    } else {
      const limitText = params.get("limit") ?? "31";
      if (!/^[1-9]\d?$/.test(limitText) || Number(limitText) > 90) {
        invalid();
      }
      const requestedDate = params.get("date");
      const date = requestedDate === "yesterday" ? yesterday : requestedDate;
      if (date !== null && (params.has("startDate") || params.has("endDate"))) {
        invalid();
      }
      if (params.has("startDate") !== params.has("endDate")) {
        invalid();
      }
      const earliest = await db.select({ date: min(meals.localDate) }).from(meals);
      const startDate = date ?? params.get("startDate") ?? (
        earliest[0]?.date && earliest[0].date < yesterday
          ? earliest[0].date : yesterday
      );
      const endDate = date ?? params.get("endDate") ?? yesterday;
      if (!isDateOnly(startDate) || !isDateOnly(endDate) || startDate > endDate || endDate > yesterday) {
        invalid();
      }
      selection = { version: 1, source, timezone, startDate, endDate, nextDate: startDate, limit: Number(limitText) };
    }
    const dates: string[] = [];
    let nextDate: string | null = selection.nextDate;
    while (nextDate !== null && dates.length < selection.limit) {
      dates.push(nextDate);
      nextDate = nextDate === selection.endDate ? null : shiftExportDate(nextDate, 1);
    }
    const rows = await db
      .select({ meal: meals, revision: revisions })
      .from(meals)
      .leftJoin(revisions, and(
        eq(meals.mealId, revisions.mealId),
        eq(meals.currentRevisionNo, revisions.revisionNo),
      ))
      .where(and(
        gte(meals.localDate, dates[0]),
        lte(meals.localDate, dates.at(-1)!),
        isNull(meals.voidedAt),
      ))
      .orderBy(asc(meals.localDate), asc(meals.mealId));
    if (rows.some((row) => !row.revision)) {
      throw new Error("Nutrition export current revision unavailable");
    }
    const revisionIds = rows.map((row) => row.revision!.mealRevisionId);
    const itemsByRevision = new Map<string, (typeof items.$inferSelect)[]>();
    for (const ids of chunkByParameterLimit(revisionIds)) {
      const itemRows = await db.select().from(items)
        .where(inArray(items.mealRevisionId, ids))
        .orderBy(asc(items.itemOrdinal), asc(items.mealItemId));
      for (const item of itemRows) {
        const group = itemsByRevision.get(item.mealRevisionId) ?? [];
        group.push(item);
        itemsByRevision.set(item.mealRevisionId, group);
      }
    }
    const days = dates.map((localDate) => {
      const dayMeals = rows.filter((row) => row.meal.localDate === localDate).map(({ meal, revision }) => {
        const metadata = { ...meal };
        delete (metadata as Partial<typeof meal>).voidedAt;
        delete (metadata as Partial<typeof meal>).currentRevisionNo;
        return {
          ...metadata,
          ...revision!,
          createdAt: meal.createdAt,
          createdBy: meal.createdBy,
          revisionCreatedAt: revision!.createdAt,
          revisionCreatedBy: revision!.createdBy,
          items: itemsByRevision.get(revision!.mealRevisionId) ?? [],
        };
      });
      const nutrients = Object.fromEntries(exportNutrients.map((key) => {
        const values = dayMeals.flatMap((meal) =>
          meal[key] !== null ? [meal[key]]
            : meal.items.length ? meal.items.map((item) => item[key]) : [null],
        );
        const known = values.filter((value): value is number => value !== null);
        return [key, {
          knownSum: known.length
            ? Math.round((known.reduce((sum, value) => sum + value, 0) + Number.EPSILON) * 1000) / 1000
            : null,
          knownValueCount: known.length,
          unknownValueCount: values.length - known.length,
          status: known.length === 0 ? "unknown"
            : known.length === values.length ? "complete" : "partial",
        }];
      }));
      const payload = { source, timezone, localDate, status: dayMeals.length ? "recorded" : "empty", meals: dayMeals, nutrients };
      return { id: `${source}:nutrition:${localDate}`, fingerprint: digest(payload), ...payload };
    });
    await transaction.commit();
    return {
      contractVersion: 1,
      source,
      timezone,
      startDate: selection.startDate,
      endDate: selection.endDate,
      days,
      nextCursor: nextDate ? encodeCursor({ ...selection, nextDate }, secret) : null,
    };
  } finally {
    transaction.close();
  }
}
