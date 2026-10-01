import { describe, expect, it } from "vitest";
import { emptyCatalogue, type MerchantProduct, putProduct } from "../../src/catalogue/merchant";
import { memoryStore } from "../../src/catalogue/store";
import { sell } from "../../src/checkout/sale";
import { link, merchantProduct } from "../fakes/merchant";
import { fakePaymentsApi, oneTimeCatalogue, type PaymentsApi } from "../fakes/payments-api";
import { testContext } from "../fixtures";

const STORED = merchantProduct({
  sku: "TSHIRT",
  stock: 3,
  pricing: { mode: "stored", amount: 2750, currency: "EUR" },
  bupayment: link(),
});

function setup(local: MerchantProduct = STORED, api: PaymentsApi = fakePaymentsApi()) {
  const catalogue = emptyCatalogue();
  putProduct(catalogue, local);
  const store = memoryStore(catalogue);
  const client = testContext({}, { fetch: api.fetch }).context.bupayment;
  return {
    api,
    store,
    stock: () => store.load().products.TSHIRT?.stock,
    sell: (orderId = "A1", sku = "TSHIRT") =>
      sell(client, store, { orderId, sku, email: "buyer@example.test" }),
  };
}

describe("sell", () => {
  it("charges the linked price at the stored amount, keyed by the order", async () => {
    const { api, sell: sale } = setup();

    const result = await sale();

    expect(result).toMatchObject({ outcome: "paid", payment: { id: "pay_1", amount: 2750 } });
    expect(api.charges).toEqual([
      {
        customerId: "cus_1",
        priceId: "price_1",
        expectedPrice: { unitAmount: 2750, currency: "EUR" },
        idempotencyKey: "order-A1",
      },
    ]);
  });

  it("asserts the last known live price, never a fresh read", async () => {
    const live = merchantProduct({
      ...STORED,
      pricing: {
        mode: "live",
        lastKnown: { amount: 2750, currency: "EUR", readAt: "2026-09-28T00:00:00.000Z" },
      },
    });
    const { api, sell: sale } = setup(live);

    await sale();

    expect(api.charges[0]?.expectedPrice).toEqual({ unitAmount: 2750, currency: "EUR" });
    expect(api.catalogue.requests).toEqual([]);
  });

  it("keeps the unit of a paid order", async () => {
    const { store, stock, sell: sale } = setup();

    await sale();

    expect(stock()).toBe(2);
    expect(store.load().reservations).toEqual({ A1: "TSHIRT" });
  });

  it("gives the unit back when the payment did not succeed", async () => {
    const api = fakePaymentsApi();
    api.paymentStatus = "pending";
    const { store, stock, sell: sale } = setup(STORED, api);

    const result = await sale();

    expect(result).toMatchObject({ outcome: "unpaid", payment: { status: "pending" } });
    expect(stock()).toBe(3);
    expect(store.load().reservations).toEqual({});
  });

  it("never sells the last unit twice when two orders race", async () => {
    const { api, stock, sell: sale } = setup(merchantProduct({ ...STORED, stock: 1 }));

    const results = await Promise.all([sale("A1"), sale("B2")]);

    expect(results.map((result) => result.outcome).sort()).toEqual(["paid", "unavailable"]);
    expect(api.payments).toHaveLength(1);
    expect(stock()).toBe(0);
  });

  it("settles an unconfirmed order on retry without taking a second unit", async () => {
    const api = fakePaymentsApi();
    api.failure = Response.json({ error: "operation_failed", message: "Down" }, { status: 503 });
    const { stock, sell: sale } = setup(STORED, api);

    const first = await sale();
    api.failure = null;
    const second = await sale();

    expect(first.outcome).toBe("unconfirmed");
    expect(second.outcome).toBe("paid");
    expect(api.payments).toHaveLength(1);
    expect(stock()).toBe(2);
  });

  it("answers a repeated paid order with the same payment and the same unit", async () => {
    const { api, stock, sell: sale } = setup();

    await sale();
    const again = await sale();

    expect(again).toMatchObject({ outcome: "paid", payment: { id: "pay_1" } });
    expect(api.payments).toHaveLength(1);
    expect(stock()).toBe(2);
  });

  it("keeps the unit of an order BuPayment can no longer settle", async () => {
    const api = fakePaymentsApi();
    api.failure = Response.json(
      { error: "idempotency_outcome_unknown", message: "Unknown" },
      { status: 409 },
    );
    const { stock, sell: sale } = setup(STORED, api);

    const result = await sale();

    expect(result.outcome).toBe("needs_reconciliation");
    expect(stock()).toBe(2);
  });

  it("refuses with the shown and current price and gives the unit back", async () => {
    const { api, stock, sell: sale } = setup(STORED, fakePaymentsApi(oneTimeCatalogue(3000)));

    const result = await sale();

    expect(result).toMatchObject({
      outcome: "price_changed",
      shown: { unitAmount: 2750, currency: "EUR" },
      current: { unitAmount: 3000, currency: "EUR" },
    });
    expect(api.payments).toEqual([]);
    expect(stock()).toBe(3);
  });

  it("answers unavailable without calling BuPayment when the stock is gone", async () => {
    const { api, sell: sale } = setup(merchantProduct({ ...STORED, stock: 0 }));

    const result = await sale();

    expect(result).toEqual({ outcome: "unavailable" });
    expect(api.customers).toEqual([]);
  });

  it.each([
    ["product_not_found", "OTHER", STORED],
    ["not_sellable", "TSHIRT", merchantProduct({ ...STORED, bupayment: null })],
    [
      "not_sellable",
      "TSHIRT",
      merchantProduct({ ...STORED, bupayment: link({ priceActive: false }) }),
    ],
    [
      "price_unknown",
      "TSHIRT",
      merchantProduct({ ...STORED, pricing: { mode: "live", lastKnown: null } }),
    ],
  ] as const)("refuses %s before calling BuPayment", async (reason, sku, local) => {
    const { api, sell: sale } = setup(local);

    const result = await sale("A1", sku);

    expect(result).toEqual({ outcome: "refused", reason });
    expect(api.charges).toEqual([]);
    expect(api.customers).toEqual([]);
  });

  it("refuses an order that already holds another product", async () => {
    const other = merchantProduct({ ...STORED, sku: "MUG" });
    const { api, store, sell: sale } = setup();
    const catalogue = store.load();
    putProduct(catalogue, other);
    catalogue.reservations.A1 = "MUG";
    store.save(catalogue);

    const result = await sale("A1", "TSHIRT");

    expect(result).toEqual({ outcome: "refused", reason: "order_mismatch" });
    expect(api.charges).toEqual([]);
  });

  it("refuses the second product when one order races for two", async () => {
    const { api, store, sell: sale } = setup();
    const catalogue = store.load();
    putProduct(catalogue, merchantProduct({ ...STORED, sku: "MUG" }));
    store.save(catalogue);

    const results = await Promise.all([sale("A1", "TSHIRT"), sale("A1", "MUG")]);

    expect(results).toEqual([
      expect.objectContaining({ outcome: "paid" }),
      { outcome: "refused", reason: "order_mismatch" },
    ]);
    expect(api.payments).toHaveLength(1);
    expect(store.load().products.MUG?.stock).toBe(3);
    expect(store.load().reservations).toEqual({ A1: "TSHIRT" });
  });

  it("gives the unit back and lets any other API failure through", async () => {
    const api = fakePaymentsApi();
    api.failure = Response.json(
      { error: "provider_capability_not_supported", message: "No charges" },
      { status: 422 },
    );
    const { store, stock, sell: sale } = setup(STORED, api);

    await expect(sale()).rejects.toMatchObject({ name: "BuPaymentError", status: 422 });
    expect(stock()).toBe(3);
    expect(store.load().reservations).toEqual({});
  });
});
