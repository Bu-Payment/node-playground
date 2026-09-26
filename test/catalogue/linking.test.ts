import { BuPaymentError } from "@bu-payment/node-sdk";
import { describe, expect, it } from "vitest";
import { type LinkRequest, linkProduct } from "../../src/catalogue/linking";
import { emptyCatalogue, putProduct } from "../../src/catalogue/merchant";
import { memoryStore } from "../../src/catalogue/store";
import { type CatalogueApi, fakeCatalogueApi, price, product } from "../fakes/catalogue-api";
import { merchantProduct, OBSERVED } from "../fakes/merchant";
import { testContext } from "../fixtures";

const LINKED_AT = new Date("2026-09-26T12:00:00.000Z");

function setup(api: CatalogueApi = defaultApi()) {
  const catalogue = emptyCatalogue();
  putProduct(
    catalogue,
    merchantProduct({ sku: "TICKET", pricing: { mode: "stored", amount: 1, currency: "EUR" } }),
  );
  const store = memoryStore(catalogue);
  const client = testContext({}, { fetch: api.fetch }).context.bupayment.catalogue;
  const link = (sku: string, request: LinkRequest) =>
    linkProduct(client, store, sku, request, () => LINKED_AT);
  return { store, link };
}

function defaultApi() {
  return fakeCatalogueApi({
    products: [product({ id: "prod_1" }), product({ id: "prod_2" })],
    prices: [price({ id: "price_1", productId: "prod_1", unitAmount: 1800 })],
  });
}

describe("linkProduct", () => {
  it("links a stored product and adopts the BuPayment price", async () => {
    const { store, link } = setup();

    const result = await link("TICKET", {
      productId: "prod_1",
      priceId: "price_1",
      pricing: "stored",
    });

    expect(result.linked).toBe(true);
    expect(store.load().products.TICKET).toMatchObject({
      pricing: { mode: "stored", amount: 1800, currency: "EUR" },
      bupayment: {
        productId: "prod_1",
        priceId: "price_1",
        sellable: true,
        productUpdatedAt: OBSERVED,
        priceUpdatedAt: OBSERVED,
      },
    });
  });

  it("links a live product with the price it just read as last known", async () => {
    const { store, link } = setup();

    await link("TICKET", { productId: "prod_1", priceId: "price_1", pricing: "live" });

    expect(store.load().products.TICKET?.pricing).toEqual({
      mode: "live",
      lastKnown: { amount: 1800, currency: "EUR", readAt: LINKED_AT.toISOString() },
    });
  });

  it("refuses an unknown local SKU before calling BuPayment", async () => {
    const api = defaultApi();
    const { link } = setup(api);

    const result = await link("__proto__", {
      productId: "prod_1",
      priceId: "price_1",
      pricing: "stored",
    });

    expect(result).toEqual({ linked: false, reason: "product_not_found" });
    expect(api.requests).toEqual([]);
  });

  it("refuses a price that belongs to another product", async () => {
    const { store, link } = setup();

    const result = await link("TICKET", {
      productId: "prod_2",
      priceId: "price_1",
      pricing: "stored",
    });

    expect(result).toEqual({ linked: false, reason: "price_not_of_product" });
    expect(store.load().products.TICKET?.bupayment).toBeNull();
  });

  it.each([
    [
      "product",
      [product({ id: "prod_1", active: false })],
      [price({ id: "price_1", productId: "prod_1" })],
    ],
    [
      "price",
      [product({ id: "prod_1" })],
      [price({ id: "price_1", productId: "prod_1", active: false })],
    ],
  ])("refuses an archived %s", async (_, products, prices) => {
    const { link } = setup(fakeCatalogueApi({ products, prices }));

    const result = await link("TICKET", {
      productId: "prod_1",
      priceId: "price_1",
      pricing: "stored",
    });

    expect(result).toEqual({ linked: false, reason: "inactive" });
  });

  it("surfaces a BuPayment resource this application cannot see", async () => {
    const { store, link } = setup();

    await expect(
      link("TICKET", { productId: "prod_missing", priceId: "price_1", pricing: "stored" }),
    ).rejects.toBeInstanceOf(BuPaymentError);
    expect(store.load().products.TICKET?.bupayment).toBeNull();
  });
});
