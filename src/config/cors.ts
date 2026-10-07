import type { CorsOptions } from "cors";
import { env } from "./env";

export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  return env.clientOrigins.includes(origin.replace(/\/+$/, ""));
}

/**
 * Credentials are required because the refresh token travels in an httpOnly
 * cookie, which means the allow-list must be explicit (no "*").
 */
export const corsOptions: CorsOptions = {
  origin(origin, callback) {
    // Same-origin / server-to-server requests have no Origin header.
    if (!origin || isAllowedOrigin(origin)) return callback(null, true);
    return callback(null, false);
  },
  credentials: true,
  methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Accept"],
  exposedHeaders: ["Retry-After"],
  maxAge: 600,
};
