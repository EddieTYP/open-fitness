import type { NextConfig } from "next";

const allowedDevOrigins = (process.env.FITNESS_DEV_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  output: "standalone",
  allowedDevOrigins:
    allowedDevOrigins.length > 0 ? allowedDevOrigins : undefined,
  outputFileTracingIncludes: {
    "/*": ["./node_modules/@libsql/darwin-*/**/*"],
  },
};

export default nextConfig;
