import { BuPaymentError } from "@bu-payment/node-sdk";
import { describe, expect, it } from "vitest";
import { applyPrice, applyProduct, emptyMirror } from "../../src/catalogue/mirror";
import { reconcileCatalogue } from "../../src/catalogue/reconcile";
import { memoryStore } from "../../src/catalogue/store";
import { type CatalogueApi, fakeCatalogueApi, price, product } from "../fakes/catalogue-api";
import { testContext } from "../fixtures";

const SWEPT_AT = new Date("2026-09-24T12:00:00.000Z");

function catalogueOf(api: CatalogueApi) {
  return testContext({}, { fetch: api.fetch }).context.bupayment.catalogue;
}

function reconcile(api: CatalogueApi, store = memoryStore()) {
  return reconcileCatalogue(catalogueOf(api), store, () => SWEPT_AT);
}

describe("reconcileCatalogue", () => {
  it("walks every page of active and inactive products and prices", async () => {
    const api = fakeCatalogueApi({
      products: [1, 2, 3, 4, 5, 6].map((n) => product({ id: `prod_${n}`, active: n !== 6 })),
      prices: [price({ id: "price_1", productId: "prod_1" })],
    });
    const store = memoryStore();

    const report = await reconcile(api, store);

    expect(report.observed).toEqual({ products: 6, prices: 1 });
    expect(Object.keys(store.load().products).sort()).toEqual([
      "prod_1",
      "prod_2",
      "prod_3",
      "prod_4",
      "prod_5",
      "prod_6",
    ]);
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

  it("observes an archived product and deactivates it locally", async () => {
    const store = memoryStore();
    const api = fakeCatalogueApi({ products: [product({ id: "prod_1" })] });
    await reconcile(api, store);
    api.products = [product({ id: "prod_1", active: false, updatedAt: "2026-09-20T00:00:00Z" })];

    const report = await reconcile(api, store);

    expect(report.changes).toEqual([{ resource: "product", id: "prod_1", change: "updated" }]);
    expect(store.load().products.prod_1?.active).toBe(false);
  });

  it("repairs a local value that drifted from BuPayment", async () => {
    const mirror = emptyMirror();
    applyPrice(mirror, price({ id: "price_1", productId: "prod_1", unitAmount: 1 }), "2026-01-01");
    const store = memoryStore(mirror);

    const report = await reconcile(
      fakeCatalogueApi({ prices: [price({ id: "price_1", productId: "prod_1" })] }),
      store,
    );

    expect(report.changes).toEqual([{ resource: "price", id: "price_1", change: "updated" }]);
    expect(store.load().prices.price_1).toMatchObject({
      cachedUnitAmount: 1500,
      syncedAt: SWEPT_AT.toISOString(),
    });
  });

  it("keeps a newer local observation over an older read", async () => {
    const mirror = emptyMirror();
    applyProduct(mirror, product({ id: "prod_1", name: "Pass", updatedAt: "2026-09-30T00:00Z" }));
    const store = memoryStore(mirror);

    const report = await reconcile(
      fakeCatalogueApi({ products: [product({ id: "prod_1", name: "Ticket" })] }),
      store,
    );

    expect(report.changes).toEqual([]);
    expect(report.stale).toBe(1);
    expect(store.load().products.prod_1?.name).toBe("Pass");
  });

  it("withdraws what this application can no longer see at all", async () => {
    const mirror = emptyMirror();
    applyProduct(mirror, product({ id: "prod_gone" }));
    applyPrice(mirror, price({ id: "price_gone", productId: "prod_gone" }), "2026-09-01");
    const store = memoryStore(mirror);

    const report = await reconcile(fakeCatalogueApi(), store);

    expect(report.changes).toEqual([
      { resource: "product", id: "prod_gone", change: "withdrawn" },
      { resource: "price", id: "price_gone", change: "withdrawn" },
    ]);
    expect(store.load().products.prod_gone?.active).toBe(false);
    expect(store.load().prices.price_gone?.active).toBe(false);
  });

  it("reports a withdrawal once, not on every later sweep", async () => {
    const mirror = emptyMirror();
    applyProduct(mirror, product({ id: "prod_gone" }));
    const store = memoryStore(mirror);
    await reconcile(fakeCatalogueApi(), store);

    const report = await reconcile(fakeCatalogueApi(), store);

    expect(report.changes).toEqual([]);
  });

  it("counts a second sweep over the same catalogue as unchanged", async () => {
    const store = memoryStore();
    const api = fakeCatalogueApi({
      products: [product({ id: "prod_1" })],
      prices: [price({ id: "price_1", productId: "prod_1" })],
    });
    await reconcile(api, store);

    const report = await reconcile(api, store);

    expect(report).toEqual({
      observed: { products: 1, prices: 1 },
      unchanged: 2,
      stale: 0,
      changes: [],
    });
  });

  it("leaves the mirror untouched when a page fails part-way through", async () => {
    const mirror = emptyMirror();
    applyProduct(mirror, product({ id: "prod_1", name: "Ticket" }));
    const store = memoryStore(mirror);
    const api = fakeCatalogueApi({
      products: [product({ id: "prod_1", name: "Pass", updatedAt: "2026-09-20T00:00Z" })],
    });
    const failing: CatalogueApi = {
      ...api,
      fetch: async (input, init) =>
        new URL(input).pathname === "/v1/prices"
          ? Response.json({ error: "operation_failed" }, { status: 503 })
          : api.fetch(input, init),
    };

    await expect(reconcile(failing, store)).rejects.toBeInstanceOf(BuPaymentError);
    expect(store.load()).toEqual(mirror);
  });
});
