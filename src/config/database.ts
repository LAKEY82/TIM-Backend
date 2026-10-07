import mongoose from "mongoose";
import { env } from "./env";
import { logger } from "../utils/logger";

// Unknown filter keys are dropped. Operator injection (e.g. `{ "$ne": null }`
// in a query string) is prevented upstream: every request value is parsed by
// Zod into a primitive or ObjectId before it reaches a query. (Mongoose's
// global `sanitizeFilter` is not used: it would also wrap our own `$in`/`$gt`.)
mongoose.set("strictQuery", true);

export async function connectDatabase(uri = env.MONGODB_URI): Promise<typeof mongoose> {
  mongoose.connection.on("disconnected", () => logger.warn("MongoDB disconnected"));
  mongoose.connection.on("reconnected", () => logger.info("MongoDB reconnected"));
  mongoose.connection.on("error", (err: Error) => logger.error("MongoDB error", { message: err.message }));

  const conn = await mongoose.connect(uri, {
    dbName: env.MONGODB_DB_NAME,
    serverSelectionTimeoutMS: 10_000,
    maxPoolSize: 20,
    // createIndex is idempotent; keeping this on guarantees the unique/email
    // indexes exist in every environment without a separate migration step.
    autoIndex: true,
  });
  logger.info("MongoDB connected", { db: conn.connection.name });
  return conn;
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}

export function isDatabaseReady(): boolean {
  return mongoose.connection.readyState === 1;
}
