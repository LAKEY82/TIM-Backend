import "./config/zod";
import cookieParser from "cookie-parser";
import cors from "cors";
import express, { Router } from "express";
import helmet from "helmet";
import morgan from "morgan";
import { corsOptions } from "./config/cors";
import { env } from "./config/env";
import { isDatabaseReady } from "./config/database";
import { requireAuth } from "./middleware/auth.middleware";
import { errorHandler, notFoundHandler } from "./middleware/error.middleware";
import { activitiesRouter } from "./routes/activities.routes";
import { analyticsRouter } from "./routes/analytics.routes";
import { authRouter } from "./routes/auth.routes";
import { clientsRouter } from "./routes/clients.routes";
import { dailyTasksRouter } from "./routes/dailyTasks.routes";
import { departmentsRouter } from "./routes/departments.routes";
import { filesRouter } from "./routes/files.routes";
import { milestonesRouter } from "./routes/milestones.routes";
import { notificationsRouter } from "./routes/notifications.routes";
import { projectsRouter } from "./routes/projects.routes";
import { searchRouter } from "./routes/search.routes";
import { settingsRouter } from "./routes/settings.routes";
import { serveStoredFile } from "./routes/storage.routes";
import { tasksRouter } from "./routes/tasks.routes";
import { teamsRouter } from "./routes/teams.routes";
import { usersRouter } from "./routes/users.routes";

export function createApp() {
  const app = express();

  // Behind Render/NGINX, trust the proxy so req.ip and secure cookies work.
  app.set("trust proxy", env.TRUST_PROXY);
  app.disable("x-powered-by");

  // A JSON API never serves HTML, so the strictest CSP applies.
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } }, crossOriginResourcePolicy: { policy: "same-site" } }));
  app.use(cors(corsOptions));
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false, limit: "100kb" }));
  app.use(cookieParser());
  if (!env.isTest && (env.LOG_REQUESTS || !env.isProduction)) app.use(morgan(env.isProduction ? "combined" : "dev"));

  app.get("/api/health", (_req, res) => {
    const db = isDatabaseReady();
    res.status(db ? 200 : 503).json({ success: db, data: { status: db ? "ok" : "degraded", db: db ? "connected" : "disconnected" } });
  });

  app.use("/api/auth", authRouter);
  // Files kept in MongoDB when no bucket is configured (unguessable keys, like public bucket URLs).
  app.get("/api/storage/*key", serveStoredFile);

  // Everything below requires a valid access token.
  const api = Router();
  api.use(requireAuth);
  api.use("/users", usersRouter);
  api.use("/departments", departmentsRouter);
  api.use("/teams", teamsRouter);
  api.use("/projects", projectsRouter);
  api.use("/tasks", tasksRouter);
  api.use("/milestones", milestonesRouter);
  api.use("/clients", clientsRouter);
  api.use("/notifications", notificationsRouter);
  api.use("/activity", activitiesRouter);
  api.use("/daily-tasks", dailyTasksRouter);
  api.use("/files", filesRouter);
  api.use("/search", searchRouter);
  api.use("/analytics", analyticsRouter);
  api.use("/settings", settingsRouter);
  app.use("/api", api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
