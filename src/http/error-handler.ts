import type { ErrorRequestHandler, RequestHandler } from "express";
import { describeFailure } from "../runtime/errors";
import type { Logger } from "../runtime/logger";

export function notFoundHandler(): RequestHandler {
  return (_request, response) => {
    response.status(404).json({ code: "route_not_found", message: "No such route." });
  };
}

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (error, request, response, _next) => {
    const failure = describeFailure(error);
    logger.error("Request failed", {
      method: request.method,
      path: request.path,
      status: failure.status,
      code: failure.code,
    });
    response.status(failure.status).json({ code: failure.code, message: failure.message });
  };
}
