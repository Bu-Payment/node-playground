import request from "supertest";
import { describe, expect, it } from "vitest";
import { appWith } from "../fakes/app";
import { CHECKOUT_URL, fakeHostedCheckoutApi, withoutDefaultProvider } from "../fakes/checkout-api";
import { link, merchantProduct } from "../fakes/merchant";

const TSHIRT = merchantProduct({
  sku: "TSHIRT",
  stock: 3,
  pricing: { mode: "stored", amount: 2750, currency: "EUR" },
  bupayment: link(),
});

const ORDER = { orderId: "A1", sku: "TSHIRT", email: "buyer@example.test" };

const CHECKOUT_ENV = {
  BUPAYMENT_CHECKOUT_DESTINATION: "tours",
  BUPAYMENT_CHECKOUT_PROVIDER: "trust-my-travel",
};

describe("POST /checkout through the hosted checkout", () => {
  it("answers with the checkout URL and holds one unit", async () => {
    const api = fakeHostedCheckoutApi();
    const { app, lines } = appWith([TSHIRT], api.fetch, CHECKOUT_ENV);

    const response = await request(app).post("/checkout").send(ORDER);

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      orderId: "A1",
      checkout: {
        id: "chk_1",
        status: "pending",
        amount: 2750,
        currency: "EUR",
        expiresAt: "2026-10-09T13:00:00.000Z",
      },
      checkoutUrl: CHECKOUT_URL,
      stock: 2,
    });
    expect(api.requests[0]?.body).toMatchObject({ provider: "trust-my-travel" });
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ message: "Hosted checkout opened", checkoutId: "chk_1" }),
    ]);
    expect(lines.join("\n")).not.toContain(CHECKOUT_URL);
  });

  it("answers 503 when the provider needs a checkout and no destination is configured", async () => {
    const { app } = appWith([TSHIRT], fakeHostedCheckoutApi().fetch);

    const response = await request(app).post("/checkout").send(ORDER);

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      code: "checkout_not_configured",
      message: "The provider needs a hosted checkout and no checkout destination is configured.",
    });
  });

  it("answers 502 with the API reason when BuPayment refuses the checkout", async () => {
    const api = fakeHostedCheckoutApi();
    api.failure = Response.json(
      { error: "checkout_live_not_enabled", message: "Live is not enabled" },
      { status: 409 },
    );
    const { app, lines } = appWith([TSHIRT], api.fetch, CHECKOUT_ENV);

    const response = await request(app).post("/checkout").send(ORDER);

    expect(response.status).toBe(502);
    expect(response.body).toEqual({
      code: "checkout_refused",
      message: "BuPayment refused the hosted checkout.",
      reason: "checkout_live_not_enabled",
    });
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      level: "error",
      message: "Hosted checkout refused",
      code: "resource_conflict",
      apiError: "checkout_live_not_enabled",
    });
  });

  it("answers 202 confirming when the checkout may have been created", async () => {
    const api = fakeHostedCheckoutApi();
    api.failure = "network";
    const { app } = appWith([TSHIRT], api.fetch, CHECKOUT_ENV);

    const response = await request(app).post("/checkout").send(ORDER);

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      orderId: "A1",
      status: "confirming",
      message: "The payment is not confirmed yet. Retry with the same orderId.",
    });
  });

  it("answers 409 for an order whose checkout already settled", async () => {
    const { app, store } = appWith([TSHIRT], fakeHostedCheckoutApi().fetch, CHECKOUT_ENV);
    await request(app).post("/checkout").send(ORDER);
    const settled = store.load();
    settled.checkouts.chk_1 = { orderId: "A1", sku: "TSHIRT", settled: "sold" };
    store.save(settled);

    const response = await request(app).post("/checkout").send(ORDER);

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      code: "checkout_closed",
      message: "That order's checkout is already settled. Use a new orderId.",
    });
  });

  it("opens the checkout with the configured provider when the environment has no default", async () => {
    const api = withoutDefaultProvider(fakeHostedCheckoutApi());
    const { app, lines } = appWith([TSHIRT], api.fetch, CHECKOUT_ENV);

    const response = await request(app).post("/checkout").send(ORDER);

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ checkoutUrl: CHECKOUT_URL, stock: 2 });
    expect(api.requests[0]?.body).toMatchObject({ provider: "trust-my-travel" });
    expect(lines.join("\n")).not.toContain(CHECKOUT_URL);
  });

  it("answers 503 asking for a default provider when no checkout provider is configured", async () => {
    const api = withoutDefaultProvider(fakeHostedCheckoutApi());
    const { app } = appWith([TSHIRT], api.fetch, {
      BUPAYMENT_CHECKOUT_DESTINATION: "tours",
    });

    const response = await request(app).post("/checkout").send(ORDER);

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      code: "default_provider_not_configured",
      message:
        "The BuPayment environment has no default provider. Choose one for the environment, or set BUPAYMENT_CHECKOUT_DESTINATION and BUPAYMENT_CHECKOUT_PROVIDER.",
    });
    expect(api.requests).toEqual([]);
  });

  it("answers 503 asking for a default provider when no checkout is configured", async () => {
    const api = withoutDefaultProvider(fakeHostedCheckoutApi());
    const { app } = appWith([TSHIRT], api.fetch, {
      BUPAYMENT_CHECKOUT_PROVIDER: "trust-my-travel",
    });

    const response = await request(app).post("/checkout").send(ORDER);

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ code: "default_provider_not_configured" });
    expect(response.body.message).toContain("BUPAYMENT_CHECKOUT_DESTINATION");
    expect(api.requests).toEqual([]);
  });
});
