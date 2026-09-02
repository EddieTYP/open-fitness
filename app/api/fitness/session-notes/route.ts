import { getDb } from "@/db";
import { auditLog, sessionNotes } from "@/db/schema";
import {
  getApiActor,
  routeError,
  unauthorizedResponse,
} from "@/lib/api-auth";
import { apiError } from "@/lib/api-error";
import {
  finiteNumber,
  isDateOnly,
  payloadSha256,
  requestId,
  requiredText,
} from "@/lib/record-utils";
import { findIdempotentReplay } from "@/lib/idempotency";

export const dynamic = "force-dynamic";

type SessionNoteInput = {
  noteId?: string;
  noteDate?: string;
  sessionId?: string | null;
  venue?: string | null;
  exerciseOrArea?: string | null;
  noteType?: string;
  pain010?: number | null;
  note?: string;
  source?: string;
};

export async function POST(request: Request) {
  try {
    const actor = await getApiActor(request);
    if (!actor) return unauthorizedResponse();

    const payload = (await request.json()) as SessionNoteInput;
    if (!isDateOnly(payload.noteDate)) {
      return apiError(
        "INVALID_SESSION_NOTE_DATE",
        400,
        { field: "noteDate" },
        "Invalid session note date",
      );
    }

    const note = requiredText(payload.note, "note");
    const noteType = requiredText(payload.noteType, "noteType");
    const idempotencyKey = requestId(request);
    const digest = await payloadSha256(payload);
    const replayedId = await findIdempotentReplay(
      idempotencyKey,
      "session_note",
      digest,
    );
    if (replayedId) {
      return Response.json({
        noteId: replayedId,
        requestId: idempotencyKey,
        replay: true,
      });
    }
    const id =
      payload.noteId?.trim() ||
      `WEB-NOTE|${payload.noteDate}|${idempotencyKey}`;
    const db = getDb();

    await db.batch([
      db.insert(sessionNotes).values({
        noteId: id,
        noteDate: payload.noteDate,
        sessionId: payload.sessionId?.trim() || null,
        venue: payload.venue?.trim() || null,
        exerciseOrArea: payload.exerciseOrArea?.trim() || null,
        noteType,
        pain010: finiteNumber(payload.pain010, {
          min: 0,
          max: 10,
          optional: true,
        }),
        note,
        source: payload.source?.trim() || "Open Fitness WebApp",
      }),
      db.insert(auditLog).values({
        requestId: idempotencyKey,
        actor: actor.id,
        operation: "insert",
        entityType: "session_note",
        entityId: id,
        payloadSha256: digest,
      }),
    ]);

    return Response.json(
      { noteId: id, requestId: idempotencyKey },
      { status: 201 },
    );
  } catch (error) {
    return routeError(error);
  }
}
