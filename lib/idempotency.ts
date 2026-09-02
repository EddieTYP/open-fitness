import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLog } from "@/db/schema";

type IdempotencyReadDb = Pick<ReturnType<typeof getDb>, "select">;

export async function findIdempotentReplay(
  requestId: string,
  entityType: string,
  payloadSha256: string,
  db: IdempotencyReadDb = getDb(),
): Promise<string | null> {
  const rows = await db
    .select({
      entityId: auditLog.entityId,
      payloadSha256: auditLog.payloadSha256,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.requestId, requestId),
        eq(auditLog.entityType, entityType),
      ),
    )
    .limit(1);
  const existing = rows[0];
  if (!existing) return null;
  if (existing.payloadSha256 !== payloadSha256) {
    throw new Error("Idempotency key conflict");
  }
  return existing.entityId;
}
