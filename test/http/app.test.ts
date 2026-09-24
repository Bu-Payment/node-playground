import { BuPaymentError } from "@bu-payment/node-sdk";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/http/app";
import { errorHandler } from "../../src/http/error-handler";
import { collectingLogger, FAKE_SECRET, testContext } from "../fixtures";

describe("createApp", () => {
  it("reports health without disclosing any credential", async () => {
    const { context } = testContext();

    const response = await request(createApp(context)).get("/healthz");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "ok",
      environment: "test",
      apiBaseUrl: "http://localhost:3000/",
    });
    expect(response.text).not.toContain(FAKE_SECRET);
  });

  it("answers an unknown route with a canonical shape", async () => {
    const { context } = testContext();

    const response = await request(createApp(context)).get("/nope");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ code: "route_not_found", message: "No such route." });
  });
});

describe("errorHandler", () => {
  function appThatThrows(error: unknown) {
    const { lines, logger } = collectingLogger();
    const app = express();
    app.get("/boom", () => {
      throw error;
    });
    app.use(errorHandler(logger));
    return { app, lines };
  }

  it("maps an SDK failure to its canonical status and code", async () => {
    const { app } = appThatThrows(
      new BuPaymentError("Application authentication is required", {
        code: "application_auth_required",
        status: 401,
      }),
    );

    const response = await request(app).get("/boom");

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      code: "application_auth_required",
      message: "Application authentication is required",
    });
  });

  it("keeps an unexpected failure out of the response body and the log", async () => {
    const { app, lines } = appThatThrows(new Error(`secret leaked: ${FAKE_SECRET}`));

    const response = await request(app).get("/boom");

    expect(response.status).toBe(500);
    expect(response.text).not.toContain(FAKE_SECRET);
    expect(lines.join("\n")).not.toContain(FAKE_SECRET);
    expect(JSON.parse(lines[0] ?? "{}")).toEqual({
      level: "error",
      message: "Request failed",
      method: "GET",
      path: "/boom",
      status: 500,
      code: "internal_error",
    });
  });
});
