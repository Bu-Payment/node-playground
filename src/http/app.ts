import express, { type Express } from "express";
import type { AppContext } from "../runtime/context";
import { errorHandler, notFoundHandler } from "./error-handler";
import { localHostsOnly } from "./host-guard";
import {
  catalogueRoute,
  changePriceRoute,
  createProductRoute,
  linkProductRoute,
} from "./routes/catalogue";
import { checkoutRoute } from "./routes/checkout";
import { healthRoute } from "./routes/health";
import { webhookRoute } from "./routes/webhook";

export function createApp(context: AppContext): Express {
  const app = express();
  app.disable("x-powered-by");
  app.post(
    "/webhooks/bupayment",
    express.raw({ type: "application/json", limit: "256kb" }),
    webhookRoute(context),
  );
  app.use(localHostsOnly(context.server.host));
  app.use(express.json({ limit: "64kb" }));
  app.get("/healthz", healthRoute(context));
  app.get("/catalogue", catalogueRoute(context));
  app.post("/products", createProductRoute(context));
  app.put("/products/:sku/link", linkProductRoute(context));
  app.put("/products/:sku/price", changePriceRoute(context));
  app.post("/checkout", checkoutRoute(context));
  app.use(notFoundHandler());
  app.use(errorHandler(context.logger));
  return app;
}
