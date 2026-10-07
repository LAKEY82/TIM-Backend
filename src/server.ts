import { createApp } from "./app";
import { connectDatabase, disconnectDatabase } from "./config/database";
import { env } from "./config/env";
import { startJobs, stopJobs } from "./jobs/deadline-reminders";
import { logger } from "./utils/logger";

async function main() {
  await connectDatabase();
  const app = createApp();
  const server = app.listen(env.PORT, () => logger.info(`TIM API listening on port ${env.PORT}`, { env: env.NODE_ENV }));
  if (env.ENABLE_JOBS) startJobs();

  const shutdown = (signal: string) => {
    logger.info(`${signal} received, shutting down`);
    stopJobs();
    server.close(() => {
      void disconnectDatabase().finally(() => process.exit(0));
    });
    // Force exit if connections don't drain.
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => logger.error("Unhandled promise rejection", { reason: String(reason) }));
}

main().catch((error: unknown) => {
  logger.error("Failed to start", { message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
