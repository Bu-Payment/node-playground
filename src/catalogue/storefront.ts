import type { Price } from "@bu-payment/node-sdk";
import { type MerchantCatalogue, type MerchantProduct, pricingFrom } from "./merchant";

export type PriceReader = (priceId: string) => Promise<Price>;

export interface StorefrontPrice {
  amount: number;
  currency: string;
  source: "stored" | "live" | "last_known";
  readAt: string | null;
}

export interface StorefrontProduct {
  sku: string;
  title: string;
  slug: string;
  imageUrl: string | null;
  stock: number;
  price: StorefrontPrice | null;
  sellable: boolean;
}

export interface LivePriceRead {
  sku: string;
  price: Price;
}

export interface Storefront {
  products: StorefrontProduct[];
  reads: LivePriceRead[];
}

export async function buildStorefront(
  catalogue: MerchantCatalogue,
  readPrice: PriceReader,
): Promise<Storefront> {
  const products = Object.values(catalogue.products).sort((left, right) =>
    left.title.localeCompare(right.title),
  );
  const shown = await Promise.all(products.map((product) => show(product, readPrice)));
  return {
    products: shown.map((entry) => entry.view),
    reads: shown.flatMap((entry) => (entry.read === undefined ? [] : [entry.read])),
  };
}

async function show(
  product: MerchantProduct,
  readPrice: PriceReader,
): Promise<{ view: StorefrontProduct; read?: LivePriceRead }> {
  const base = {
    sku: product.sku,
    title: product.title,
    slug: product.slug,
    imageUrl: product.imageUrl,
    stock: product.stock,
    sellable: product.bupayment?.sellable ?? false,
  };
  const pricing = product.pricing;
  if (pricing.mode === "stored") {
    const price = { amount: pricing.amount, currency: pricing.currency };
    return { view: { ...base, price: { ...price, source: "stored", readAt: null } } };
  }
  const link = product.bupayment;
  const read = link === null ? undefined : await readPrice(link.priceId).catch(() => undefined);
  if (read !== undefined) {
    const price = { amount: read.unitAmount, currency: read.currency };
    return {
      view: { ...base, price: { ...price, source: "live", readAt: null } },
      read: { sku: product.sku, price: read },
    };
  }
  const last = pricing.lastKnown;
  if (last === null) {
    return { view: { ...base, price: null } };
  }
  const price = { amount: last.amount, currency: last.currency };
  return { view: { ...base, price: { ...price, source: "last_known", readAt: last.readAt } } };
}

export function rememberLivePrice(
  current: MerchantProduct,
  read: LivePriceRead,
  readAt: string,
): MerchantProduct | undefined {
  if (current.pricing.mode !== "live" || current.bupayment?.priceId !== read.price.id) {
    return undefined;
  }
  return { ...current, pricing: pricingFrom("live", read.price, readAt) };
}
