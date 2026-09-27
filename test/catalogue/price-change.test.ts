import { BuPaymentError, Header } from "@bu-payment/node-sdk";
import { describe, expect, it } from "vitest";
import { emptyCatalogue, type MerchantProduct, putProduct } from "../../src/catalogue/merchant";
import { changePrice } from "../../src/catalogue/price-change";
import { memoryStore } from "../../src/catalogue/store";
import {
  type CatalogueApi,
  fakeCatalogueApi,
  price,
  product,
  WRITTEN_AT,
} from "../fakes/catalogue-api";
import { link, merchantProduct, OBSERVED } from "../fakes/merchant";
import { testContext } from "../fixtures";

const CHANGED_AT = new Date("2026-09-27T12:00:00.000Z");

function setup(local: MerchantProduct, api: CatalogueApi = defaultApi()) {
  const catalogue = emptyCatalogue();
  putProduct(catalogue, local);
  const store = memoryStore(catalogue);
  const client = testContext({}, { fetch: api.fetch }).context.bupayment.catalogue;
  return {
    api,
    store,
    change: (sku: string, amount: number) =>
      changePrice(client, store, sku, amount, () => CHANGED_AT),
  };
}

function defaultApi() {
  return fakeCatalogueApi({
    products: [product({ id: "prod_1", defaultPriceId: "price_0" })],
    prices: [
      price({ id: "price_0", productId: "prod_1", currency: "USD" }),
      price({ id: "price_1", productId: "prod_1" }),
    ],
  });
}

const LINKED = merchantProduct({ sku: "TICKET", bupayment: link() });

describe("changePrice", () => {
  it("changes the price of an unlinked product locally, without calling BuPayment", async () => {
    const { api, store, change } = setup(merchantProduct({ sku: "LOCAL" }));

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
    const { api, store, change } = setup(LINKED);

    const result = await change("TICKET", 1800);

    expect(result).toMatchObject({ changed: true, archivePending: null });
    expect(api.requests.map((request) => `${request.method} ${request.url.pathname}`)).toEqual([
      "GET /v1/prices/price_1",
      "POST /v1/products/prod_1/prices",
      "POST /v1/prices/price_1/archive",
    ]);
    expect(api.requests[1]?.body).toEqual({ unitAmount: 1800, currency: "EUR" });
    expect(api.requests[2]?.body).toEqual({ expectedUpdatedAt: OBSERVED });
    expect(api.prices.find((row) => row.id === "price_1")?.active).toBe(false);
    expect(store.load().products.TICKET).toMatchObject({
      pricing: { mode: "stored", amount: 1800, currency: "EUR" },
      bupayment: { priceId: "price_new_3", priceActive: true, priceUpdatedAt: WRITTEN_AT },
    });
  });

  it("sends an idempotency key on both writes", async () => {
    const { api, change } = setup(LINKED);

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
    const { change } = setup(LINKED, api);

    await change("TICKET", 4500);

    expect(api.requests[1]?.body).toEqual({
      unitAmount: 4500,
      currency: "EUR",
      recurring: { interval: "month", intervalCount: 3 },
    });
  });

  it("records the new price as the last known one of a live product", async () => {
    const live = { ...LINKED, pricing: { mode: "live" as const, lastKnown: null } };
    const { store, change } = setup(live);

    await change("TICKET", 1800);

    expect(store.load().products.TICKET?.pricing).toEqual({
      mode: "live",
      lastKnown: { amount: 1800, currency: "EUR", readAt: CHANGED_AT.toISOString() },
    });
  });

  it("cannot archive the price of a single-price product yet, because it is the default", async () => {
    const api = fakeCatalogueApi({
      products: [product({ id: "prod_1", defaultPriceId: "price_1" })],
      prices: [price({ id: "price_1", productId: "prod_1" })],
    });
    const { store, change } = setup(LINKED, api);

    const result = await change("TICKET", 1800);

    const error = result.changed ? result.archivePending?.error : undefined;
    expect(error).toBeInstanceOf(BuPaymentError);
    expect((error as BuPaymentError).metadata?.apiError).toBe("default_price_in_use");
    expect(store.load().products.TICKET?.bupayment?.priceId).toBe("price_new_2");
  });

  it("links the new price and reports the archive as pending when it fails", async () => {
    const api = defaultApi();
    api.failArchive = true;
    const { store, change } = setup(LINKED, api);

    const result = await change("TICKET", 1800);

    expect(result.changed && result.archivePending?.previousPriceId).toBe("price_1");
    expect(store.load().products.TICKET?.bupayment?.priceId).toBe("price_new_3");
    expect(api.prices.find((row) => row.id === "price_1")?.active).toBe(true);
  });

  it("reports the archive as pending when the old price changed since it was last seen", async () => {
    const { change } = setup(
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
    const { store, change } = setup(orphan);
    const before = store.load();

    await expect(change("TICKET", 1800)).rejects.toBeInstanceOf(BuPaymentError);
    expect(store.load()).toEqual(before);
  });

  it.each([
    ["a linked", LINKED, link({ priceId: "price_other" })],
    ["an unlinked", merchantProduct({ sku: "TICKET" }), link()],
  ])("refuses to overwrite %s product relinked while its price was changing", async (_, local, relinked) => {
    const { store, change } = setup(local);
    const load = store.load.bind(store);
    let loads = 0;
    store.load = () => {
      loads += 1;
      const catalogue = load();
      if (loads > 1) {
        putProduct(catalogue, { ...local, bupayment: relinked });
      }
      return catalogue;
    };

    const result = await change("TICKET", 1800);

    expect(result).toMatchObject({ changed: false, reason: "product_changed" });
  });

  it("archives the price it created when the product was relinked meanwhile", async () => {
    const { api, store, change } = setup(LINKED);
    const load = store.load.bind(store);
    let loads = 0;
    store.load = () => {
      loads += 1;
      const catalogue = load();
      if (loads > 1) {
        putProduct(catalogue, { ...LINKED, bupayment: link({ priceId: "price_other" }) });
      }
      return catalogue;
    };

    const result = await change("TICKET", 1800);

    expect(result).toEqual({
      changed: false,
      reason: "product_changed",
      orphan: { priceId: "price_new_3", archived: true, error: null },
    });
    expect(api.prices.find((row) => row.id === "price_new_3")?.active).toBe(false);
  });

  it("reports an unused price it could not archive", async () => {
    const api = defaultApi();
    const { store, change } = setup(LINKED, api);
    const load = store.load.bind(store);
    let loads = 0;
    store.load = () => {
      loads += 1;
      const catalogue = load();
      if (loads > 1) {
        api.failArchive = true;
        putProduct(catalogue, { ...LINKED, bupayment: link({ priceId: "price_other" }) });
      }
      return catalogue;
    };

    const result = await change("TICKET", 1800);

    expect(result).toMatchObject({
      reason: "product_changed",
      orphan: { priceId: "price_new_3", archived: false },
    });
  });

  it("keeps the change when a webhook already moved the link to the new price", async () => {
    const { api, store, change } = setup(LINKED);
    const load = store.load.bind(store);
    let loads = 0;
    store.load = () => {
      loads += 1;
      const catalogue = load();
      if (loads > 1) {
        putProduct(catalogue, { ...LINKED, bupayment: link({ priceId: "price_new_3" }) });
      }
      return catalogue;
    };

    const result = await change("TICKET", 1800);

    expect(result.changed).toBe(true);
    expect(api.prices.find((row) => row.id === "price_new_3")?.active).toBe(true);
  });

  it("sends the same idempotency key when the same change is retried", async () => {
    const first = setup(LINKED);
    const second = setup(LINKED);

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
    const { change } = setup(LINKED, api);

    await change("TICKET", 1800);

    expect(api.requests[1]?.body).toMatchObject({ currency: "USD" });
  });

  it("refuses to edit an unlinked product that has no stored price", async () => {
    const live = merchantProduct({ sku: "LOCAL", pricing: { mode: "live", lastKnown: null } });
    const { change } = setup(live);

    expect(await change("LOCAL", 900)).toEqual({
      changed: false,
      reason: "product_changed",
      orphan: null,
    });
  });

  it("refuses an unknown SKU before calling BuPayment", async () => {
    const { api, change } = setup(LINKED);

    expect(await change("__proto__", 1800)).toEqual({
      changed: false,
      reason: "product_not_found",
    });
    expect(api.requests).toEqual([]);
  });
});
