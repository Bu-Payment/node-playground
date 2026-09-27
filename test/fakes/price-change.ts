import { emptyCatalogue, type MerchantProduct, putProduct } from "../../src/catalogue/merchant";
import { changePrice } from "../../src/catalogue/price-change";
import { memoryStore } from "../../src/catalogue/store";
import { testContext } from "../fixtures";
import { type CatalogueApi, fakeCatalogueApi, price, product } from "./catalogue-api";
import { link, merchantProduct } from "./merchant";

export const CHANGED_AT = new Date("2026-09-27T12:00:00.000Z");

export const LINKED = merchantProduct({ sku: "TICKET", bupayment: link() });

export function setupPriceChange(local: MerchantProduct, api: CatalogueApi = twoPriceApi()) {
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

export function singlePriceApi() {
  return fakeCatalogueApi({
    products: [product({ id: "prod_1", defaultPriceId: "price_1" })],
    prices: [price({ id: "price_1", productId: "prod_1" })],
  });
}

export function twoPriceApi() {
  return fakeCatalogueApi({
    products: [product({ id: "prod_1", defaultPriceId: "price_0" })],
    prices: [
      price({ id: "price_0", productId: "prod_1", currency: "USD" }),
      price({ id: "price_1", productId: "prod_1" }),
    ],
  });
}
