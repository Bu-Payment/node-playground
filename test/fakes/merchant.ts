import type { CatalogueLink, MerchantProduct } from "../../src/catalogue/merchant";

export const OBSERVED = "2026-09-01T00:00:00.000Z";

export function merchantProduct(
  overrides: Partial<MerchantProduct> & Pick<MerchantProduct, "sku">,
): MerchantProduct {
  return {
    title: `Title ${overrides.sku}`,
    slug: overrides.sku.toLowerCase(),
    imageUrl: null,
    stock: 10,
    pricing: { mode: "stored", amount: 1500, currency: "EUR" },
    bupayment: null,
    ...overrides,
  };
}

export function link(overrides: Partial<CatalogueLink> = {}): CatalogueLink {
  return {
    productId: "prod_1",
    priceId: "price_1",
    sellable: true,
    productUpdatedAt: OBSERVED,
    priceUpdatedAt: OBSERVED,
    ...overrides,
  };
}
