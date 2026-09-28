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
    sell: (sku: string, email = "buyer@example.test") => sell(client, store, { sku, email }),
  };
}

describe("sell", () => {
  it("charges the linked price at the stored amount the storefront showed", async () => {
    const { api, sell: sale } = setup();

    const result = await sale("TSHIRT");

    expect(result).toMatchObject({
      sold: true,
      payment: { id: "pay_1", status: "succeeded", amount: 2750, currency: "EUR" },
    });
    expect(api.charges).toEqual([
      {
        customerId: "cus_1",
        priceId: "price_1",
        expectedPrice: { unitAmount: 2750, currency: "EUR" },
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

    await sale("TSHIRT");

    expect(api.charges[0]?.expectedPrice).toEqual({ unitAmount: 2750, currency: "EUR" });
    expect(api.catalogue.requests).toEqual([]);
  });

  it("takes one unit off the stock when the payment succeeded", async () => {
    const { store, sell: sale } = setup();

    const result = await sale("TSHIRT");

    expect(result).toMatchObject({ sold: true, stock: 2 });
    expect(store.load().products.TSHIRT?.stock).toBe(2);
  });

  it("leaves the stock alone when the payment has not succeeded", async () => {
    const api = fakePaymentsApi();
    api.paymentStatus = "pending";
    const { store, sell: sale } = setup(STORED, api);

    const result = await sale("TSHIRT");

    expect(result).toMatchObject({ sold: true, stock: 3, payment: { status: "pending" } });
    expect(store.load().products.TSHIRT?.stock).toBe(3);
  });

  it("never sells the last unit twice when two checkouts race", async () => {
    const { api, store, sell: sale } = setup(merchantProduct({ ...STORED, stock: 1 }));

    const results = await Promise.all([sale("TSHIRT"), sale("TSHIRT")]);

    expect(results.map((result) => (result.sold ? "sold" : result.reason)).sort()).toEqual([
      "out_of_stock",
      "sold",
    ]);
    expect(api.payments).toHaveLength(1);
    expect(store.load().products.TSHIRT?.stock).toBe(0);
  });

  it("gives the unit back when BuPayment fails", async () => {
    const api = fakePaymentsApi();
    api.failure = Response.json({ error: "operation_failed", message: "Down" }, { status: 503 });
    const { store, sell: sale } = setup(STORED, api);

    await expect(sale("TSHIRT")).rejects.toMatchObject({ status: 503 });

    expect(store.load().products.TSHIRT?.stock).toBe(3);
  });

  it("reuses the customer that already has the email", async () => {
    const api = fakePaymentsApi();
    const { sell: sale } = setup(STORED, api);

    await sale("TSHIRT");
    await sale("TSHIRT");

    expect(api.customers).toHaveLength(1);
    expect(api.charges.map((entry) => entry.customerId)).toEqual(["cus_1", "cus_1"]);
  });

  it("refuses with the shown and current price when the canonical price changed", async () => {
    const { api, store, sell: sale } = setup(STORED, fakePaymentsApi(oneTimeCatalogue(3000)));

    const result = await sale("TSHIRT");

    expect(result).toEqual({
      sold: false,
      reason: "price_changed",
      shown: { amount: 2750, currency: "EUR" },
      current: { amount: 3000, currency: "EUR" },
    });
    expect(api.payments).toEqual([]);
    expect(store.load().products.TSHIRT?.stock).toBe(3);
  });

  it("still refuses a changed price when the API leaves the current one out", async () => {
    const api = fakePaymentsApi();
    api.failure = Response.json(
      { error: "price_changed", message: "The price no longer matches" },
      { status: 409 },
    );
    const { sell: sale } = setup(STORED, api);

    const result = await sale("TSHIRT");

    expect(result).toMatchObject({ sold: false, reason: "price_changed", current: null });
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
    ["out_of_stock", "TSHIRT", merchantProduct({ ...STORED, stock: 0 })],
  ] as const)("refuses %s before calling BuPayment", async (reason, sku, local) => {
    const { api, sell: sale } = setup(local);

    const result = await sale(sku);

    expect(result).toEqual({ sold: false, reason });
    expect(api.charges).toEqual([]);
    expect(api.customers).toEqual([]);
  });

  it("lets any other API failure through", async () => {
    const api = fakePaymentsApi();
    api.failure = Response.json(
      { error: "capability_unsupported", message: "The provider cannot charge" },
      { status: 422 },
    );
    const { sell: sale } = setup(STORED, api);

    await expect(sale("TSHIRT")).rejects.toMatchObject({ name: "BuPaymentError", status: 422 });
  });
});
