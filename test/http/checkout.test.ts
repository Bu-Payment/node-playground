import request from "supertest";
import { describe, expect, it } from "vitest";
import { appWith } from "../fakes/app";
import { link, merchantProduct } from "../fakes/merchant";
import { fakePaymentsApi, oneTimeCatalogue } from "../fakes/payments-api";

const TSHIRT = merchantProduct({
  sku: "TSHIRT",
  stock: 3,
  pricing: { mode: "stored", amount: 2750, currency: "EUR" },
  bupayment: link(),
});

const ORDER = { sku: "TSHIRT", email: "buyer@example.test" };

describe("POST /checkout", () => {
  it("sells one unit at the displayed price", async () => {
    const { app } = appWith([TSHIRT], fakePaymentsApi().fetch);

    const response = await request(app).post("/checkout").send(ORDER);

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      payment: { id: "pay_1", status: "succeeded", amount: 2750, currency: "EUR" },
      stock: 2,
    });
  });

  it("asks the client to reload the price when BuPayment refuses a changed one", async () => {
    const { app } = appWith([TSHIRT], fakePaymentsApi(oneTimeCatalogue(3000)).fetch);

    const response = await request(app).post("/checkout").send(ORDER);

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      code: "price_changed",
      message: "The price changed since it was shown. Reload the catalogue and try again.",
      shown: { amount: 2750, currency: "EUR" },
      current: { amount: 3000, currency: "EUR" },
    });
  });

  it.each([
    [404, "product_not_found", { ...ORDER, sku: "OTHER" }, TSHIRT],
    [409, "not_sellable", ORDER, merchantProduct({ ...TSHIRT, bupayment: null })],
    [
      409,
      "price_unknown",
      ORDER,
      merchantProduct({ ...TSHIRT, pricing: { mode: "live", lastKnown: null } }),
    ],
    [409, "out_of_stock", ORDER, merchantProduct({ ...TSHIRT, stock: 0 })],
  ] as const)("answers %i %s", async (status, code, body, local) => {
    const { app } = appWith([local], fakePaymentsApi().fetch);

    const response = await request(app).post("/checkout").send(body);

    expect(response.status).toBe(status);
    expect(response.body.code).toBe(code);
    expect(response.body.message).toMatch(/\S/);
  });

  it.each([
    [{ sku: "TSHIRT" }],
    [{ sku: "TSHIRT", email: "not-an-email" }],
    [{ sku: "", email: "buyer@example.test" }],
    [{ ...ORDER, quantity: 2 }],
  ])("rejects an invalid order %j", async (body) => {
    const { app } = appWith([TSHIRT], fakePaymentsApi().fetch);

    const response = await request(app).post("/checkout").send(body);

    expect(response.status).toBe(422);
    expect(response.body.code).toBe("checkout_invalid");
  });

  it("reports a provider failure with the API's own code", async () => {
    const api = fakePaymentsApi();
    api.failure = Response.json(
      { error: "operation_failed", message: "The provider cannot charge" },
      { status: 503 },
    );
    const { app, store, lines } = appWith([TSHIRT], api.fetch);

    const response = await request(app).post("/checkout").send(ORDER);

    expect(response.status).toBe(503);
    expect(response.body.code).toBe("operation_failed");
    expect(store.load().products.TSHIRT?.stock).toBe(3);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ path: "/checkout", status: 503 });
  });
});
