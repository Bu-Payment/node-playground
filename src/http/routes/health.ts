import type { RequestHandler } from "express";
import type { AppContext } from "../../runtime/context";

export function healthRoute(context: AppContext): RequestHandler {
  return (_request, response) => {
    response.json({ status: "ok", environment: context.client.environment });
  };
}
