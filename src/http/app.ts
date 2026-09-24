import express, { type Express } from "express";
import type { AppContext } from "../runtime/context";
import { errorHandler, notFoundHandler } from "./error-handler";
import { healthRoute } from "./routes/health";

export function createApp(context: AppContext): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));
  app.get("/healthz", healthRoute(context));
  app.use(notFoundHandler());
  app.use(errorHandler(context.logger));
  return app;
}
