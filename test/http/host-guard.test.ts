import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/http/app";
import { product } from "../fakes/catalogue-api";
import { productEvent, signed, WEBHOOK_SECRET } from "../fakes/webhook";
import { testContext } from "../fixtures";

function appOn(host: string) {
  const { context } = testContext({ HOST: host, BUPAYMENT_WEBHOOK_SECRET: WEBHOOK_SECRET });
  return createApp(context);
}

describe("localHostsOnly", () => {
  it.each(["localhost:9003", "127.0.0.1:9003", "[::1]:9003"])("accepts %s", async (host) => {
    const response = await request(appOn("127.0.0.1")).get("/healthz").set("Host", host);

    expect(response.status).toBe(200);
  });

  it("refuses a rebound hostname on the merchant routes", async () => {
    const response = await request(appOn("127.0.0.1"))
      .put("/products/TICKET/price")
      .set("Host", "attacker.example:9003")
      .send({ amount: 0 });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("host_not_allowed");
  });

  it("accepts the configured host name", async () => {
    const response = await request(appOn("shop.internal"))
      .get("/healthz")
      .set("Host", "shop.internal:9003");

    expect(response.status).toBe(200);
  });

  it("matches the configured host regardless of case", async () => {
    const response = await request(appOn("Shop.Internal"))
      .get("/healthz")
      .set("Host", "shop.internal");

    expect(response.status).toBe(200);
  });

  it("matches a configured IPv6 address in its bracketed form", async () => {
    const response = await request(appOn("fd00::5")).get("/healthz").set("Host", "[fd00::5]:9003");

    expect(response.status).toBe(200);
  });

  it("does not widen the list to any name when bound to every interface", async () => {
    const response = await request(appOn("0.0.0.0")).get("/healthz").set("Host", "0.0.0.0:9003");

    expect(response.status).toBe(403);
  });

  it("leaves the webhook reachable under a public name", async () => {
    const delivery = signed(
      productEvent("catalogue.product.archived.v1", product({ id: "prod_1", active: false })),
    );

    const response = await request(appOn("127.0.0.1"))
      .post("/webhooks/bupayment")
      .set({ ...delivery.headers, Host: "hooks.example.com" })
      .send(delivery.body);

    expect(response.status).toBe(200);
  });
});
