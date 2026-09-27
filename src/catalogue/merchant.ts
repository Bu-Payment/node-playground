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

const LinkFactsSchema = z.object({
  productId: z.string(),
  priceId: z.string(),
  productActive: z.boolean().default(true),
  priceActive: z.boolean().default(true),
  productAssigned: z.boolean().default(true),
  priceAssigned: z.boolean().default(true),
  productUpdatedAt: z.string(),
  priceUpdatedAt: z.string(),
  productAssignmentAt: z.string().nullable().default(null),
  priceAssignmentAt: z.string().nullable().default(null),
});

const CatalogueLinkSchema = z.preprocess(withoutLegacySellable, LinkFactsSchema);

const MerchantProductSchema = z.object({
  sku: z.string(),
  title: z.string(),
  slug: z.string(),
  imageUrl: z.string().nullable(),
  stock: z.number().int().nonnegative(),
  pricing: z.discriminatedUnion("mode", [StoredPricingSchema, LivePricingSchema]),
  bupayment: CatalogueLinkSchema.nullable(),
});

const ReceivedWebhooksSchema = z.object({
  deliveries: z.record(z.string(), z.string()),
  events: z.record(z.string(), z.string()),
});

export const MerchantCatalogueSchema = z.object({
  products: z.record(z.string(), MerchantProductSchema),
  received: ReceivedWebhooksSchema.default({ deliveries: {}, events: {} }),
});

export const PRICING_MODES = ["stored", "live"] as const;
export type PricingMode = (typeof PRICING_MODES)[number];
export type CatalogueLink = z.infer<typeof LinkFactsSchema>;
export type MerchantProduct = z.infer<typeof MerchantProductSchema>;
export type MerchantCatalogue = z.infer<typeof MerchantCatalogueSchema>;

export function emptyCatalogue(): MerchantCatalogue {
  return { products: {}, received: { deliveries: {}, events: {} } };
}

export function isSellable(link: CatalogueLink | null): boolean {
  return (
    link?.productActive === true && link.priceActive && link.productAssigned && link.priceAssigned
  );
}

export function findProduct(
  catalogue: MerchantCatalogue,
  sku: string,
): MerchantProduct | undefined {
  return Object.hasOwn(catalogue.products, sku) ? catalogue.products[sku] : undefined;
}

export function putProduct(catalogue: MerchantCatalogue, product: MerchantProduct): void {
  defineOwnKey(catalogue.products, product.sku, product);
}

export function defineOwnKey<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    value,
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

function withoutLegacySellable(value: unknown): unknown {
  if (typeof value !== "object" || value === null || !("sellable" in value)) {
    return value;
  }
  const { sellable, ...link } = value as Record<string, unknown>;
  return sellable === false && !("productActive" in link)
    ? { ...link, productActive: false }
    : link;
}
