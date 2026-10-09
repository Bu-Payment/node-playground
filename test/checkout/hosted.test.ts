import { describe, expect, it } from "vitest";
import { emptyCatalogue, type MerchantProduct, putProduct } from "../../src/catalogue/merchant";
import { memoryStore } from "../../src/catalogue/store";
import type { HostedCheckoutSettings } from "../../src/checkout/hosted";
import { sell } from "../../src/checkout/sale";
import { CHECKOUT_URL, fakeHostedCheckoutApi, type HostedCheckoutApi } from "../fakes/checkout-api";
import { link, merchantProduct } from "../fakes/merchant";
import { testContext } from "../fixtures";

const TSHIRT = merchantProduct({
  sku: "TSHIRT",
  stock: 3,
  pricing: { mode: "stored", amount: 2750, currency: "EUR" },
  bupayment: link(),
});

const TOURS: HostedCheckoutSettings = { destination: "tours", provider: null };

function setup(
  options: { product?: MerchantProduct; settings?: HostedCheckoutSettings | null } = {},
  api: HostedCheckoutApi = fakeHostedCheckoutApi(),
) {
  const catalogue = emptyCatalogue();
  putProduct(catalogue, options.product ?? TSHIRT);
  const store = memoryStore(catalogue);
  const client = testContext({}, { fetch: api.fetch }).context.bupayment;
  const settings = options.settings === undefined ? TOURS : options.settings;
  return {
    api,
    store,
    stock: () => store.load().products.TSHIRT?.stock,
    sell: (orderId = "A1", sku = "TSHIRT") =>
      sell(client, store, { orderId, sku, email: "buyer@example.test" }, settings),
  };
}

function failing(body: object, status: number) {
  const api = fakeHostedCheckoutApi();
  api.failure = Response.json(body, { status });
  return api;
}

describe("sell through the hosted checkout", () => {
  it("opens a hosted checkout at the displayed price when the provider cannot charge directly", async () => {
    const { api, store, stock, sell: sale } = setup();

    const result = await sale();

    expect(result).toMatchObject({
      outcome: "checkout_open",
      checkout: { id: "chk_1", checkoutUrl: CHECKOUT_URL },
    });
    expect(api.requests).toEqual([
      {
        body: {
          priceId: "price_1",
          expectedPrice: { unitAmount: 2750, currency: "EUR" },
          customer: { email: "buyer@example.test" },
          destinationKey: "tours",
          reference: "A1",
        },
        idempotencyKey: "A1",
      },
    ]);
    expect(stock()).toBe(2);
    expect(store.load().reservations).toEqual({ A1: "TSHIRT" });
    expect(store.load().checkouts).toEqual({
      chk_1: { orderId: "A1", sku: "TSHIRT", settled: null },
    });
    expect(JSON.stringify(store.load())).not.toContain(CHECKOUT_URL);
  });

  it("names the configured provider", async () => {
    const { api, sell: sale } = setup({
      settings: { destination: "tours", provider: "trust-my-travel" },
    });

    await sale();

    expect(api.requests[0]?.body).toMatchObject({ provider: "trust-my-travel" });
  });

  it("goes straight back to the same checkout when the order retries", async () => {
    const { api, stock, sell: sale } = setup();

    await sale();
    const retried = await sale();

    expect(retried).toMatchObject({ outcome: "checkout_open", checkout: { id: "chk_1" } });
    expect(api.directCharges).toBe(1);
    expect(api.requests.map((request) => request.idempotencyKey)).toEqual(["A1", "A1"]);
    expect(stock()).toBe(2);
  });

  it("refuses without touching the stock when no checkout destination is configured", async () => {
    const { api, stock, sell: sale } = setup({ settings: null });

    expect(await sale()).toEqual({ outcome: "refused", reason: "checkout_not_configured" });
    expect(api.requests).toEqual([]);
    expect(stock()).toBe(3);
  });

  it("opens no checkout for a product out of stock", async () => {
    const { api, sell: sale } = setup({ product: { ...TSHIRT, stock: 0 } });

    expect(await sale()).toEqual({ outcome: "unavailable" });
    expect(api.requests).toEqual([]);
  });

  it("opens nothing when an open checkout's unit is gone and the stock with it", async () => {
    const { api, store, sell: sale } = setup({ product: { ...TSHIRT, stock: 0 } });
    const placed = store.load();
    placed.checkouts.chk_1 = { orderId: "A1", sku: "TSHIRT", settled: null };
    store.save(placed);

    expect(await sale()).toEqual({ outcome: "unavailable" });
    expect(api.requests).toEqual([]);
  });

  it("releases the unit when the checkout refuses a changed price", async () => {
    const api = failing(
      {
        error: "price_changed",
        message: "Changed",
        price: { id: "price_1", unitAmount: 3000, currency: "EUR", active: true, updatedAt: "x" },
      },
      409,
    );
    const { stock, store, sell: sale } = setup({}, api);

    expect(await sale()).toMatchObject({
      outcome: "price_changed",
      shown: { unitAmount: 2750, currency: "EUR" },
      current: { unitAmount: 3000 },
    });
    expect(stock()).toBe(3);
    expect(store.load().reservations).toEqual({});
  });

  it.each([
    ["checkout_destination_unavailable", 409],
    ["checkout_provider_unknown", 422],
    ["checkout_unavailable", 503],
    ["checkout_provider_failed", 502],
  ])("releases the unit when BuPayment refuses the checkout with %s", async (code, status) => {
    const { stock, store, sell: sale } = setup({}, failing({ error: code, message: "No" }, status));

    const result = await sale();

    expect(result).toMatchObject({ outcome: "checkout_refused" });
    expect(result.outcome === "checkout_refused" && result.error.metadata?.apiError).toBe(code);
    expect(stock()).toBe(3);
    expect(store.load().checkouts).toEqual({});
  });

  it("keeps the open checkout's unit when a retry of the order is refused", async () => {
    const { api, stock, store, sell: sale } = setup();
    await sale();
    api.failure = Response.json(
      { error: "idempotency_key_reused", message: "Different body" },
      { status: 422 },
    );

    expect(await sale()).toMatchObject({ outcome: "checkout_refused" });
    expect(stock()).toBe(2);
    expect(store.load().reservations).toEqual({ A1: "TSHIRT" });
  });

  it.each([
    ["the network fails", "network" as const],
    [
      "another request with the key is in progress",
      Response.json({ error: "idempotency_in_progress", message: "Wait" }, { status: 409 }),
    ],
  ])("keeps the unit held when %s", async (_, failure) => {
    const api = fakeHostedCheckoutApi();
    api.failure = failure;
    const { stock, sell: sale } = setup({}, api);

    expect(await sale()).toMatchObject({ outcome: "unconfirmed" });
    expect(stock()).toBe(2);
  });

  it("charges directly when the provider can, even with a checkout configured", async () => {
    const api = fakeHostedCheckoutApi();
    api.payments.failure = null;
    const { stock, sell: sale } = setup({}, api);

    expect(await sale()).toMatchObject({ outcome: "paid" });
    expect(api.requests).toEqual([]);
    expect(stock()).toBe(2);
  });

  it("lets any other direct failure through rather than opening a checkout", async () => {
    const api = fakeHostedCheckoutApi();
    api.payments.failure = Response.json(
      { error: "payment_method_required", message: "No method" },
      { status: 422 },
    );
    const { stock, sell: sale } = setup({}, api);

    await expect(sale()).rejects.toMatchObject({ name: "BuPaymentError", status: 422 });
    expect(api.requests).toEqual([]);
    expect(stock()).toBe(3);
  });

  it("keeps the unit held when the checkout may have been created", async () => {
    const {
      stock,
      store,
      sell: sale,
    } = setup({}, failing({ error: "internal_error", message: "Boom" }, 500));

    expect(await sale()).toMatchObject({ outcome: "unconfirmed" });
    expect(stock()).toBe(2);
    expect(store.load().reservations).toEqual({ A1: "TSHIRT" });
  });

  it("refuses an order whose checkout already settled", async () => {
    const { store, sell: sale } = setup();
    await sale();
    const settled = store.load();
    settled.checkouts.chk_1 = { orderId: "A1", sku: "TSHIRT", settled: "released" };
    store.save(settled);

    expect(await sale()).toEqual({ outcome: "refused", reason: "checkout_closed" });
  });

  it("refuses an order whose checkout belongs to another product", async () => {
    const { api, store, sell: sale } = setup();
    const placed = store.load();
    placed.checkouts.chk_9 = { orderId: "A1", sku: "MUG", settled: null };
    store.save(placed);

    expect(await sale()).toEqual({ outcome: "refused", reason: "order_mismatch" });
    expect(api.requests).toEqual([]);
  });
});
