import {
  isTrustedMutationOrigin,
  serializeClearedOwnerSessionCookie,
} from "../../../lib/owner-auth-policy.mjs";
import { readOwnerAuthEnvironment } from "../../../lib/owner-auth-env.mjs";

export const dynamic = "force-dynamic";

function privateHeaders(init: HeadersInit = {}) {
  const headers = new Headers(init);
  headers.set("Cache-Control", "private, no-store, max-age=0");
  headers.set("Pragma", "no-cache");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  return headers;
}

export async function POST(request: Request) {
  const environment = readOwnerAuthEnvironment();
  if (
    !isTrustedMutationOrigin(request, {
      nodeEnv: environment.nodeEnv,
      publicOrigin: environment.publicOrigin ?? undefined,
    })
  ) {
    return new Response(JSON.stringify({ error: "Request origin is not allowed" }), {
      status: 403,
      headers: privateHeaders({
        "Content-Type": "application/json; charset=utf-8",
      }),
    });
  }

  const headers = privateHeaders({ Location: "/login" });
  headers.set(
    "Set-Cookie",
    serializeClearedOwnerSessionCookie({
      secure: environment.secureCookie,
    }),
  );
  return new Response(null, { status: 303, headers });
}
