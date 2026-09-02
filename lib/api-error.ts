export const API_ERROR_CODE_PATTERN =
  /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;

const ASCII_COMPATIBILITY_ERROR_PATTERN = /^[\x20-\x7e]+$/;

export type ApiErrorFacts = Record<string, unknown>;

export type ApiErrorEnvelope = {
  errorCode: string;
  facts: ApiErrorFacts;
  error?: string;
};

function isFacts(value: unknown): value is ApiErrorFacts {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function apiError(
  errorCode: string,
  status: number,
  facts: ApiErrorFacts = {},
  error?: string,
) {
  if (!API_ERROR_CODE_PATTERN.test(errorCode)) {
    throw new TypeError(`Invalid API error code: ${errorCode}`);
  }
  if (!Number.isInteger(status) || status < 400 || status > 599) {
    throw new RangeError(`Invalid API error status: ${status}`);
  }
  if (!isFacts(facts)) {
    throw new TypeError("API error facts must be an object");
  }

  const redacted = status >= 500;
  const compatibilityError = redacted ? "Internal server error" : error;
  if (
    compatibilityError !== undefined &&
    (!compatibilityError ||
      !ASCII_COMPATIBILITY_ERROR_PATTERN.test(compatibilityError))
  ) {
    throw new TypeError("API compatibility error must be non-empty ASCII text");
  }

  const body: ApiErrorEnvelope = {
    errorCode,
    facts: redacted ? {} : facts,
    ...(compatibilityError === undefined
      ? {}
      : { error: compatibilityError }),
  };
  return Response.json(body, { status });
}
