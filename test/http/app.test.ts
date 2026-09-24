import { BuPaymentError } from "@bu-payment/node-sdk";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/http/app";
import type { AppContext } from "../../src/runtime/context";
import { FAKE_SECRET, testContext } from "../fixtures";

function contextThatFailsOnHealth(failure: unknown): {
  context: AppContext;
  lines: string[];
} {
  const { context, lines } = testContext();
  const client = new Proxy(context.client, {
    get(target, property, receiver) {
      if (property === "environment") {
        throw failure;
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return { context: { ...context, client }, lines };
}

describe("createApp", () => {
  it("reports health without disclosing any credential", async () => {
    const { context } = testContext();

    const response = await request(createApp(context)).get("/healthz");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok", environment: "test" });
    expect(response.text).not.toContain(FAKE_SECRET);
  });

  it("does not announce the server implementation", async () => {
    const { context } = testContext();

    const response = await request(createApp(context)).get("/healthz");

    expect(response.headers["x-powered-by"]).toBeUndefined();
  });

  it("answers an unknown route with a canonical shape", async () => {
    const { context } = testContext();

    const response = await request(createApp(context)).get("/nope");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ code: "route_not_found", message: "No such route." });
  });

  it("maps an SDK failure raised by a route to its canonical status and code", async () => {
    const { context } = contextThatFailsOnHealth(
      new BuPaymentError("Application authentication is required", {
        code: "application_auth_required",
        status: 401,
      }),
    );

    const response = await request(createApp(context)).get("/healthz");

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      code: "application_auth_required",
      message: "Application authentication is required",
    });
  });

  it("keeps an unexpected failure out of the response body and the log", async () => {
    const { context, lines } = contextThatFailsOnHealth(new Error(`secret leaked: ${FAKE_SECRET}`));

    const response = await request(createApp(context)).get("/healthz");

    expect(response.status).toBe(500);
    expect(response.text).not.toContain(FAKE_SECRET);
    expect(lines.join("\n")).not.toContain(FAKE_SECRET);
    expect(JSON.parse(lines[0] ?? "{}")).toEqual({
      level: "error",
      message: "Request failed",
      method: "GET",
      path: "/healthz",
      status: 500,
      code: "internal_error",
    });
  });

  it("blames the caller for a malformed request body", async () => {
    const { context } = testContext();

    const response = await request(createApp(context))
      .post("/healthz")
      .set("Content-Type", "application/json")
      .send("{");

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      code: "request_invalid",
      message: "The request could not be read.",
    });
  });

  it("refuses a request body above the documented limit", async () => {
    const { context } = testContext();

    const response = await request(createApp(context))
      .post("/healthz")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ padding: "x".repeat(70_000) }));

    expect(response.status).toBe(413);
    expect(response.body.code).toBe("request_invalid");
  });
});
