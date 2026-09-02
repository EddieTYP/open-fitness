import { apiError } from "./api-error.ts";

export class ApiActorResolutionError extends Error {
  readonly resolutionCause: unknown;

  constructor(cause: unknown) {
    super("API actor resolution failed");
    this.name = "ApiActorResolutionError";
    this.resolutionCause = cause;
  }
}

export function unauthorizedResponse() {
  return apiError(
    "AUTHENTICATION_REQUIRED",
    401,
    {},
    "Authentication required",
  );
}

export function routeError(error: unknown) {
  if (error instanceof ApiActorResolutionError) {
    console.error("API actor resolution failed", error.resolutionCause);
    return apiError("INTERNAL_ERROR", 500);
  }

  const message =
    error instanceof Error ? error.message : "Unexpected database error";
  if (
    message.includes("Invalid numeric value") ||
    message.includes("Value must be") ||
    message.includes("must be a positive integer") ||
    message.includes("must use YYYY-MM-DD") ||
    message.startsWith("Invalid ") ||
    message.startsWith("Unsupported ") ||
    message.startsWith("items must ") ||
    message.includes(" is not part of the current version") ||
    message.endsWith(" is required")
  ) {
    return apiError("INVALID_REQUEST", 400, {}, "Invalid request");
  }
  if (message.includes("Idempotency key conflict")) {
    return apiError(
      "IDEMPOTENCY_KEY_CONFLICT",
      409,
      {},
      "Idempotency key conflict",
    );
  }
  if (
    message.includes("UNIQUE constraint failed") ||
    message.includes("constraint failed")
  ) {
    return apiError("RESOURCE_CONFLICT", 409, {}, "Resource conflict");
  }

  console.error("Fitness record write failed", error);
  return apiError("INTERNAL_ERROR", 500);
}
