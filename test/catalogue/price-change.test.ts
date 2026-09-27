import { BuPaymentError, Header } from "@bu-payment/node-sdk";
import { describe, expect, it } from "vitest";
import {
  type CatalogueApi,
  fakeCatalogueApi,
  price,
  product,
  WRITTEN_AT,
} from "../fakes/catalogue-api";
import { link, merchantProduct, OBSERVED } from "../fakes/merchant";
import {
  CHANGED_AT,
  LINKED,
  setupPriceChange,
  singlePriceApi,
  twoPriceApi,
} from "../fakes/price-change";

describe("changePrice", () => {
  it("changes the price of an unlinked product locally, without calling BuPayment", async () => {
    const { api, store, change } = setupPriceChange(merchantProduct({ sku: "LOCAL" }));

    const result = await change("LOCAL", 900);

    expect(result.changed).toBe(true);
    expect(store.load().products.LOCAL?.pricing).toEqual({
      mode: "stored",
      amount: 900,
      currency: "EUR",
    });
    expect(api.requests).toEqual([]);
  });

  it("changes a linked price in BuPayment first, then updates the local copy", async () => {
    const { api, store, change } = setupPriceChange(LINKED);

    const result = await change("TICKET", 1800);

    expect(result).toMatchObject({ changed: true, archivePending: null });
    expect(api.requests.map((request) => `${request.method} ${request.url.pathname}`)).toEqual([
      "GET /v1/prices/price_1",
      "GET /v1/products/prod_1",
      "POST /v1/products/prod_1/prices",
      "POST /v1/prices/price_1/archive",
    ]);
    expect(api.requests[2]?.body).toEqual({ unitAmount: 1800, currency: "EUR" });
    expect(api.requests[3]?.body).toEqual({ expectedUpdatedAt: OBSERVED });
    expect(api.prices.find((row) => row.id === "price_1")?.active).toBe(false);
    expect(store.load().products.TICKET).toMatchObject({
      pricing: { mode: "stored", amount: 1800, currency: "EUR" },
      bupayment: { priceId: "price_new_3", priceActive: true, priceUpdatedAt: WRITTEN_AT },
    });
  });

  it("sends an idempotency key on both writes", async () => {
    const { api, change } = setupPriceChange(LINKED);

    await change("TICKET", 1800);

    const writes = api.requests.filter((request) => request.method === "POST");
    expect(writes.map((request) => request.headers[Header.IDEMPOTENCY_KEY])).toEqual([
      expect.stringMatching(/\S/),
      expect.stringMatching(/\S/),
    ]);
  });

  it("keeps the recurrence of the price it replaces", async () => {
    const api = fakeCatalogueApi({
      products: [product({ id: "prod_1", defaultPriceId: "price_1" })],
      prices: [
        price({
          id: "price_1",
          productId: "prod_1",
          type: "recurring",
          recurring: { interval: "month", intervalCount: 3 },
        }),
      ],
    });
    const { change } = setupPriceChange(LINKED, api);

    await change("TICKET", 4500);

    expect(api.requests[2]?.body).toEqual({
      unitAmount: 4500,
      currency: "EUR",
      recurring: { interval: "month", intervalCount: 3 },
    });
  });

  it("records the new price as the last known one of a live product", async () => {
    const live = { ...LINKED, pricing: { mode: "live" as const, lastKnown: null } };
    const { store, change } = setupPriceChange(live);

    await change("TICKET", 1800);

    expect(store.load().products.TICKET?.pricing).toEqual({
      mode: "live",
      lastKnown: { amount: 1800, currency: "EUR", readAt: CHANGED_AT.toISOString() },
    });
  });

  it("moves the default to the new price before archiving the old one", async () => {
    const api = singlePriceApi();
    const { store, change } = setupPriceChange(LINKED, api);

    const result = await change("TICKET", 1800);

    expect(result).toMatchObject({ changed: true, archivePending: null });
    expect(api.requests.map((request) => `${request.method} ${request.url.pathname}`)).toEqual([
      "GET /v1/prices/price_1",
      "GET /v1/products/prod_1",
      "POST /v1/products/prod_1/prices",
      "PUT /v1/products/prod_1/default-price",
      "POST /v1/prices/price_1/archive",
    ]);
    expect(api.products[0]?.defaultPriceId).toBe("price_new_2");
    expect(api.prices.find((row) => row.id === "price_1")?.active).toBe(false);
    expect(store.load().products.TICKET?.bupayment?.priceId).toBe("price_new_2");
  });

  it("links the new price and reports the archive as pending when the default cannot move", async () => {
    const api = singlePriceApi();
    api.failDefaultPrice = true;
    const { store, change } = setupPriceChange(LINKED, api);

    const result = await change("TICKET", 1800);

    expect(result.changed && result.archivePending).toMatchObject({
      outcome: "default_failed",
      previousPriceId: "price_1",
    });
    expect(store.load().products.TICKET?.bupayment?.priceId).toBe("price_new_2");
    expect(api.products[0]?.defaultPriceId).toBe("price_1");
    expect(api.prices.find((row) => row.id === "price_1")?.active).toBe(true);
  });

  it("links the new price and reports the archive as pending when it fails", async () => {
    const api = twoPriceApi();
    api.failArchive = true;
    const { store, change } = setupPriceChange(LINKED, api);

    const result = await change("TICKET", 1800);

    expect(result.changed && result.archivePending?.previousPriceId).toBe("price_1");
    expect(store.load().products.TICKET?.bupayment?.priceId).toBe("price_new_3");
    expect(api.prices.find((row) => row.id === "price_1")?.active).toBe(true);
  });

  it("reports the archive as pending when the old price changed since it was last seen", async () => {
    const { change } = setupPriceChange(
      merchantProduct({
        sku: "TICKET",
        bupayment: link({ priceUpdatedAt: "2026-08-01T00:00:00Z" }),
      }),
    );

    const result = await change("TICKET", 1800);

    expect(result.changed && result.archivePending?.error).toBeInstanceOf(BuPaymentError);
  });

  it("leaves the local product untouched when BuPayment refuses the new price", async () => {
    const orphan = merchantProduct({
      sku: "TICKET",
      bupayment: link({ productId: "prod_missing" }),
    });
    const { store, change } = setupPriceChange(orphan);
    const before = store.load();

    await expect(change("TICKET", 1800)).rejects.toBeInstanceOf(BuPaymentError);
    expect(store.load()).toEqual(before);
  });

  it("sends the same idempotency key when the same change is retried", async () => {
    const first = setupPriceChange(LINKED);
    const second = setupPriceChange(LINKED);

    await first.change("TICKET", 1800);
    await second.change("TICKET", 1800);

    const keyOf = (api: CatalogueApi) =>
      api.requests.find((request) => request.method === "POST")?.headers[Header.IDEMPOTENCY_KEY];
    expect(keyOf(first.api)).toBe("price-change:TICKET:price_1:unrecorded:1800");
    expect(keyOf(second.api)).toBe(keyOf(first.api));
  });

  it("keeps the currency of the price it replaces", async () => {
    const api = fakeCatalogueApi({
      products: [product({ id: "prod_1", defaultPriceId: "price_0" })],
      prices: [
        price({ id: "price_0", productId: "prod_1" }),
        price({ id: "price_1", productId: "prod_1", currency: "USD" }),
      ],
    });
    const { change } = setupPriceChange(LINKED, api);

    await change("TICKET", 1800);

    expect(api.requests[2]?.body).toMatchObject({ currency: "USD" });
  });

  it("refuses to edit an unlinked product that has no stored price", async () => {
    const live = merchantProduct({ sku: "LOCAL", pricing: { mode: "live", lastKnown: null } });
    const { change } = setupPriceChange(live);

    expect(await change("LOCAL", 900)).toEqual({
      changed: false,
      reason: "product_changed",
      orphan: null,
    });
  });

  it("refuses an unknown SKU before calling BuPayment", async () => {
    const { api, change } = setupPriceChange(LINKED);

    expect(await change("__proto__", 1800)).toEqual({
      changed: false,
      reason: "product_not_found",
    });
    expect(api.requests).toEqual([]);
  });
});
