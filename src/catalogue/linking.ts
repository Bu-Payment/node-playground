import type { CatalogueClient } from "@bu-payment/node-sdk";
import { findProduct, type MerchantProduct, type PricingMode, pricingFrom } from "./merchant";
import { type CatalogueStore, updateProduct } from "./store";

export interface LinkRequest {
  productId: string;
  priceId: string;
  pricing: PricingMode;
}

export type LinkResult =
  | { linked: true; product: MerchantProduct }
  | { linked: false; reason: "product_not_found" | "price_not_of_product" | "inactive" };

export async function linkProduct(
  catalogue: CatalogueClient,
  store: CatalogueStore,
  sku: string,
  request: LinkRequest,
  now: () => Date = () => new Date(),
): Promise<LinkResult> {
  const local = findProduct(store.load(), sku);
  if (local === undefined) {
    return { linked: false, reason: "product_not_found" };
  }
  const [product, price] = await Promise.all([
    catalogue.product(request.productId).get(),
    catalogue.price(request.priceId).get(),
  ]);
  if (price.productId !== product.id) {
    return { linked: false, reason: "price_not_of_product" };
  }
  if (!product.active || !price.active) {
    return { linked: false, reason: "inactive" };
  }
  const readAt = now().toISOString();
  const linked = updateProduct(store, sku, (current) => ({
    ...current,
    pricing: pricingFrom(request.pricing, price, readAt),
    bupayment: {
      productId: product.id,
      priceId: price.id,
      sellable: true,
      productUpdatedAt: product.updatedAt,
      priceUpdatedAt: price.updatedAt,
    },
  }));
  return linked === undefined
    ? { linked: false, reason: "product_not_found" }
    : { linked: true, product: linked };
}
