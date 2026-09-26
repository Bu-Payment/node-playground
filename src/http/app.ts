import express, { type Express } from "express";
import type { AppContext } from "../runtime/context";
import { errorHandler, notFoundHandler } from "./error-handler";
import { catalogueRoute, createProductRoute, linkProductRoute } from "./routes/catalogue";
import { healthRoute } from "./routes/health";

export function createApp(context: AppContext): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));
  app.get("/healthz", healthRoute(context));
  app.get("/catalogue", catalogueRoute(context));
  app.post("/products", createProductRoute(context));
  app.put("/products/:sku/link", linkProductRoute(context));
  app.use(notFoundHandler());
  app.use(errorHandler(context.logger));
  return app;
}
