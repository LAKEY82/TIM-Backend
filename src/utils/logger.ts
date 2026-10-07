/* eslint-disable no-console */

type Meta = Record<string, unknown>;

/** Minimal structured logger: JSON in production, readable lines in development. */
function write(level: "info" | "warn" | "error", message: string, meta?: Meta) {
  if (process.env.NODE_ENV === "test" && level !== "error") return;
  if (process.env.NODE_ENV === "production") {
    console[level](JSON.stringify({ level, message, time: new Date().toISOString(), ...meta }));
  } else {
    console[level](`[${level}] ${message}`, meta ?? "");
  }
}

export const logger = {
  info: (message: string, meta?: Meta) => write("info", message, meta),
  warn: (message: string, meta?: Meta) => write("warn", message, meta),
  error: (message: string, meta?: Meta) => write("error", message, meta),
};
