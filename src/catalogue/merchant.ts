import type { Price } from "@bu-payment/node-sdk";
import { z } from "zod";

export const MoneySchema = z.object({
  amount: z.number().int().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
});

const StoredPricingSchema = MoneySchema.extend({ mode: z.literal("stored") });

const LivePricingSchema = z.object({
  mode: z.literal("live"),
  lastKnown: MoneySchema.extend({ readAt: z.string() }).nullable(),
});

const CatalogueLinkSchema = z.object({
  productId: z.string(),
  priceId: z.string(),
  sellable: z.boolean(),
  productUpdatedAt: z.string(),
  priceUpdatedAt: z.string(),
});

const MerchantProductSchema = z.object({
  sku: z.string(),
  title: z.string(),
  slug: z.string(),
  imageUrl: z.string().nullable(),
  stock: z.number().int().nonnegative(),
  pricing: z.discriminatedUnion("mode", [StoredPricingSchema, LivePricingSchema]),
  bupayment: CatalogueLinkSchema.nullable(),
});

export const MerchantCatalogueSchema = z.object({
  products: z.record(z.string(), MerchantProductSchema),
});

export const PRICING_MODES = ["stored", "live"] as const;
export type PricingMode = (typeof PRICING_MODES)[number];
export type CatalogueLink = z.infer<typeof CatalogueLinkSchema>;
export type MerchantProduct = z.infer<typeof MerchantProductSchema>;
export type MerchantCatalogue = z.infer<typeof MerchantCatalogueSchema>;

export function emptyCatalogue(): MerchantCatalogue {
  return { products: {} };
}

export function findProduct(
  catalogue: MerchantCatalogue,
  sku: string,
): MerchantProduct | undefined {
  return Object.hasOwn(catalogue.products, sku) ? catalogue.products[sku] : undefined;
}

export function putProduct(catalogue: MerchantCatalogue, product: MerchantProduct): void {
  Object.defineProperty(catalogue.products, product.sku, {
    value: product,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

export function isOlder(candidate: string, stored: string): boolean {
  const candidateTime = Date.parse(candidate);
  return Number.isNaN(candidateTime) || candidateTime < Date.parse(stored);
}

export function pricingFrom(
  mode: PricingMode,
  price: Price,
  readAt: string,
): MerchantProduct["pricing"] {
  const money = { amount: price.unitAmount, currency: price.currency };
  return mode === "stored"
    ? { mode: "stored", ...money }
    : { mode: "live", lastKnown: { ...money, readAt } };
}
