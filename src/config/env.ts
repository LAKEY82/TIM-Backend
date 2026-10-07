import "dotenv/config";
import { z } from "zod";

/**
 * All configuration comes from environment variables and is validated once at
 * startup, so a misconfigured deploy fails fast instead of at first request.
 */
const bool = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((v) => v === "true" || v === "1");

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(5000),

    MONGODB_URI: z.string().min(1, "MONGODB_URI is required"),
    MONGODB_DB_NAME: z.string().optional(),

    JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET must be at least 32 characters"),
    JWT_REFRESH_SECRET: z.string().min(32, "JWT_REFRESH_SECRET must be at least 32 characters"),
    ACCESS_TOKEN_TTL: z.string().default("15m"),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),

    /** Comma-separated list of allowed browser origins (the frontend URL[s]). */
    CLIENT_URL: z.string().min(1, "CLIENT_URL is required"),
    COOKIE_DOMAIN: z.string().optional(),
    /** Defaults: "none" in production (cross-site Vercel ↔ Render), "lax" otherwise. */
    COOKIE_SAMESITE: z.enum(["lax", "strict", "none"]).optional(),
    /** Number of reverse proxies in front of the app (Render/Heroku/NGINX = 1). */
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),

    BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),

    // Email (optional). Without SMTP, reset/invite links are only logged in development.
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().positive().optional(),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    SMTP_SECURE: bool,
    MAIL_FROM: z.string().default("TIM <no-reply@example.com>"),

    // S3-compatible object storage (optional). Without it, uploads return 503.
    STORAGE_BUCKET: z.string().optional(),
    STORAGE_REGION: z.string().default("auto"),
    STORAGE_ENDPOINT: z.string().optional(),
    STORAGE_ACCESS_KEY_ID: z.string().optional(),
    STORAGE_SECRET_ACCESS_KEY: z.string().optional(),
    STORAGE_PUBLIC_URL: z.string().optional(),
    /** This API's public base URL, used for links to files kept in MongoDB. Defaults to http://localhost:PORT. */
    API_PUBLIC_URL: z.string().optional(),
    STORAGE_FORCE_PATH_STYLE: bool,
    MAX_UPLOAD_MB: z.coerce.number().positive().default(25),

    /** Hourly background jobs (deadline reminders). */
    ENABLE_JOBS: bool,
    LOG_REQUESTS: bool,
  })
  .refine((e) => e.JWT_ACCESS_SECRET !== e.JWT_REFRESH_SECRET, {
    path: ["JWT_REFRESH_SECRET"],
    message: "JWT_REFRESH_SECRET must differ from JWT_ACCESS_SECRET",
  });

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const details = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
  // Never print values: they may be secrets.
  throw new Error(`Invalid environment configuration:\n${details}`);
}

const raw = parsed.data;

export const env = {
  ...raw,
  isProduction: raw.NODE_ENV === "production",
  isTest: raw.NODE_ENV === "test",
  clientOrigins: raw.CLIENT_URL.split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean),
  cookieSameSite: raw.COOKIE_SAMESITE ?? (raw.NODE_ENV === "production" ? "none" : "lax"),
  storageConfigured: Boolean(raw.STORAGE_BUCKET && raw.STORAGE_ACCESS_KEY_ID && raw.STORAGE_SECRET_ACCESS_KEY),
  smtpConfigured: Boolean(raw.SMTP_HOST),
  apiUrl: (raw.API_PUBLIC_URL || `http://localhost:${raw.PORT}`).replace(/\/+$/, ""),
  /** Base URL used in password reset / invite links. */
  appUrl: raw.CLIENT_URL.split(",")[0]!.trim().replace(/\/+$/, ""),
} as const;

export type Env = typeof env;
