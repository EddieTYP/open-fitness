function normalizedValue(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

export function readOwnerAuthEnvironment(environment = process.env) {
  const nodeEnv = normalizedValue(environment.NODE_ENV);
  return {
    nodeEnv: nodeEnv ?? undefined,
    passwordHash: normalizedValue(environment.FITNESS_OWNER_PASSWORD_HASH),
    publicOrigin: normalizedValue(environment.FITNESS_PUBLIC_ORIGIN),
    secureCookie: nodeEnv === "production",
    sessionSecret: normalizedValue(environment.FITNESS_SESSION_SECRET),
  };
}
