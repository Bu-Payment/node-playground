import { BuPaymentError } from "@bu-payment/node-sdk";
import { describe, expect, it } from "vitest";
import { emptyCatalogue, putProduct } from "../../src/catalogue/merchant";
import { reconcileCatalogue } from "../../src/catalogue/reconcile";
import { memoryStore } from "../../src/catalogue/store";
import { type CatalogueApi, fakeCatalogueApi, price, product } from "../fakes/catalogue-api";
import { link, merchantProduct } from "../fakes/merchant";
import { testContext } from "../fixtures";

const SWEPT_AT = new Date("2026-09-26T12:00:00.000Z");
const LATER = "2026-09-20T00:00:00.000Z";

function reconcile(api: CatalogueApi, store = memoryStore()) {
  const client = testContext({}, { fetch: api.fetch }).context.bupayment.catalogue;
  return reconcileCatalogue(client, store, () => SWEPT_AT);
}

function storeWith(...products: ReturnType<typeof merchantProduct>[]) {
  const catalogue = emptyCatalogue();
  for (const entry of products) {
    putProduct(catalogue, entry);
  }
  return memoryStore(catalogue);
}

describe("reconcileCatalogue", () => {
  it("walks every page of active and inactive products and prices", async () => {
    const api = fakeCatalogueApi({
      products: [1, 2, 3, 4, 5, 6].map((n) => product({ id: `prod_${n}`, active: n !== 6 })),
      prices: [price({ id: "price_1", productId: "prod_1" })],
    });

    const report = await reconcile(api);

    expect(report.observed).toEqual({ products: 6, prices: 1 });
    expect(
      api.requests.map((request) => `${request.url.pathname}?${request.url.searchParams}`),
    ).toEqual([
      "/v1/products?active=true",
      "/v1/products?active=true&cursor=2",
      "/v1/products?active=true&cursor=4",
      "/v1/products?active=false",
      "/v1/prices?active=true",
      "/v1/prices?active=false",
    ]);
  });

  it("observes an archived product through the inactive pass", async () => {
    const store = storeWith(merchantProduct({ sku: "TICKET", bupayment: link() }));
    const api = fakeCatalogueApi({
      products: [product({ id: "prod_1", active: false, updatedAt: LATER })],
      prices: [price({ id: "price_1", productId: "prod_1" })],
    });

    const report = await reconcile(api, store);

    expect(report.changes).toEqual([{ sku: "TICKET", outcome: "archived" }]);
    expect(store.load().products.TICKET?.bupayment?.sellable).toBe(false);
  });

  it("pulls a changed stored price and counts the rest as in sync", async () => {
    const store = storeWith(
      merchantProduct({ sku: "TICKET", bupayment: link() }),
      merchantProduct({
        sku: "PASS",
        bupayment: link({ productId: "prod_2", priceId: "price_2" }),
      }),
      merchantProduct({ sku: "LOCAL" }),
    );
    const api = fakeCatalogueApi({
      products: [product({ id: "prod_1" }), product({ id: "prod_2" })],
      prices: [
        price({ id: "price_1", productId: "prod_1", unitAmount: 1800, updatedAt: LATER }),
        price({ id: "price_2", productId: "prod_2" }),
      ],
    });

    const report = await reconcile(api, store);

    expect(report.changes).toEqual([{ sku: "TICKET", outcome: "updated" }]);
    expect(report.inSync).toBe(1);
    expect(store.load().products.TICKET?.pricing).toEqual({
      mode: "stored",
      amount: 1800,
      currency: "EUR",
    });
    expect(store.load().products.LOCAL?.bupayment).toBeNull();
  });

  it("lists active BuPayment products no local product links to", async () => {
    const store = storeWith(merchantProduct({ sku: "TICKET", bupayment: link() }));
    const api = fakeCatalogueApi({
      products: [
        product({ id: "prod_1" }),
        product({ id: "prod_new" }),
        product({ id: "prod_old", active: false }),
      ],
      prices: [price({ id: "price_1", productId: "prod_1" })],
    });

    expect((await reconcile(api, store)).unlinked).toEqual(["prod_new"]);
  });

  it("leaves the catalogue untouched when a page fails part-way through", async () => {
    const store = storeWith(merchantProduct({ sku: "TICKET", bupayment: link() }));
    const before = store.load();
    const api = fakeCatalogueApi({
      products: [product({ id: "prod_1", active: false, updatedAt: LATER })],
    });
    const failing: CatalogueApi = {
      ...api,
      fetch: async (input, init) =>
        new URL(input).pathname === "/v1/prices"
          ? Response.json({ error: "operation_failed" }, { status: 503 })
          : api.fetch(input, init),
    };

    await expect(reconcile(failing, store)).rejects.toBeInstanceOf(BuPaymentError);
    expect(store.load()).toEqual(before);
  });
});
