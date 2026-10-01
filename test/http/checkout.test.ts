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

const ORDER = { orderId: "A1", sku: "TSHIRT", email: "buyer@example.test" };

const REFUSAL_MESSAGES = {
  product_not_found: "No such local product.",
  not_sellable: "The product is not linked to an active BuPayment price.",
  price_unknown: "No price has been shown for this product yet. Load the catalogue first.",
  order_mismatch: "That orderId already belongs to another product.",
  out_of_stock: "The product is out of stock.",
};

function failing(body: object, status: number) {
  const api = fakePaymentsApi();
  api.failure = Response.json(body, { status });
  return api;
}

describe("POST /checkout", () => {
  it("sells one unit at the displayed price", async () => {
    const { app } = appWith([TSHIRT], fakePaymentsApi().fetch);

    const response = await request(app).post("/checkout").send(ORDER);

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      orderId: "A1",
      payment: { id: "pay_1", status: "succeeded", amount: 2750, currency: "EUR" },
      stock: 2,
    });
  });

  it("reports a payment that did not succeed", async () => {
    const api = fakePaymentsApi();
    api.paymentStatus = "pending";
    const { app } = appWith([TSHIRT], api.fetch);

    const response = await request(app).post("/checkout").send(ORDER);

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      orderId: "A1",
      payment: { id: "pay_1", status: "pending", amount: 2750, currency: "EUR" },
      stock: 3,
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

  it("answers a changed price with no current one when the API leaves it out", async () => {
    const api = failing({ error: "price_changed", message: "Changed" }, 409);
    const { app } = appWith([TSHIRT], api.fetch);

    const response = await request(app).post("/checkout").send(ORDER);

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: "price_changed", current: null });
  });

  it("tells the client to retry the same order when the payment is unconfirmed", async () => {
    const api = failing({ error: "operation_failed", message: "Down" }, 503);
    const { app, lines } = appWith([TSHIRT], api.fetch);

    const response = await request(app).post("/checkout").send(ORDER);

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      orderId: "A1",
      status: "confirming",
      message: "The payment is not confirmed yet. Retry with the same orderId.",
    });
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      level: "info",
      message: "Payment unconfirmed",
      orderId: "A1",
      code: "operation_failed",
    });
  });

  it("puts an order BuPayment cannot settle under review and alerts the log", async () => {
    const api = failing({ error: "idempotency_outcome_unknown", message: "Unknown" }, 409);
    const { app, lines } = appWith([TSHIRT], api.fetch);

    const response = await request(app).post("/checkout").send(ORDER);

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      orderId: "A1",
      status: "under_review",
      message: "The payment needs to be checked before this order can go on.",
    });
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      level: "error",
      message: "Payment needs reconciliation",
      orderId: "A1",
      sku: "TSHIRT",
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
    expect(response.body).toEqual({ code, message: REFUSAL_MESSAGES[code] });
  });

  it("refuses to reuse an order for another product", async () => {
    const { app } = appWith(
      [TSHIRT, merchantProduct({ ...TSHIRT, sku: "MUG" })],
      fakePaymentsApi().fetch,
    );

    await request(app).post("/checkout").send(ORDER);
    const response = await request(app)
      .post("/checkout")
      .send({ ...ORDER, sku: "MUG" });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      code: "order_mismatch",
      message: REFUSAL_MESSAGES.order_mismatch,
    });
  });

  it.each([
    [{ sku: "TSHIRT", email: "buyer@example.test" }],
    [{ ...ORDER, email: "not-an-email" }],
    [{ ...ORDER, sku: "" }],
    [{ ...ORDER, orderId: "../A1" }],
    [{ ...ORDER, quantity: 2 }],
  ])("rejects an invalid order %j", async (body) => {
    const { app } = appWith([TSHIRT], fakePaymentsApi().fetch);

    const response = await request(app).post("/checkout").send(body);

    expect(response.status).toBe(422);
    expect(response.body.code).toBe("checkout_invalid");
  });

  it("reports a provider refusal with the API's own code and gives the unit back", async () => {
    const api = failing({ error: "operation_failed", message: "No charges" }, 422);
    const { app, store, lines } = appWith([TSHIRT], api.fetch);

    const response = await request(app).post("/checkout").send(ORDER);

    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      code: "operation_failed",
      message: "BuPayment could not complete the request.",
    });
    expect(store.load().products.TSHIRT?.stock).toBe(3);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ path: "/checkout", status: 422 });
  });
});
