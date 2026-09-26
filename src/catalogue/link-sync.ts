import type { Price, Product } from "@bu-payment/node-sdk";
import { type CatalogueLink, isOlder, type MerchantProduct, pricingFrom } from "./merchant";

export interface RemoteCatalogue {
  products: ReadonlyMap<string, Product>;
  prices: ReadonlyMap<string, Price>;
}

export type LinkOutcome =
  | "in_sync"
  | "updated"
  | "repointed"
  | "price_needs_decision"
  | "archived"
  | "withdrawn"
  | "stale";

export interface LinkSyncResult {
  outcome: LinkOutcome;
  product: MerchantProduct;
}

export function indexRemote(
  products: readonly Product[],
  prices: readonly Price[],
): RemoteCatalogue {
  return { products: latestById(products), prices: latestById(prices) };
}

export function syncLink(
  product: MerchantProduct,
  remote: RemoteCatalogue,
  readAt: string,
): LinkSyncResult {
  const link = product.bupayment;
  if (link === null) {
    return { outcome: "in_sync", product };
  }
  const remoteProduct = remote.products.get(link.productId);
  if (remoteProduct === undefined) {
    return unsellable(product, link, "withdrawn");
  }
  const linkedPrice = remote.prices.get(link.priceId);
  if (isStale(link, remoteProduct, linkedPrice)) {
    return { outcome: "stale", product };
  }
  if (!remoteProduct.active) {
    return unsellable(product, { ...link, productUpdatedAt: remoteProduct.updatedAt }, "archived");
  }
  const current = currentPrice(remoteProduct, linkedPrice, remote);
  if (current === undefined) {
    return {
      outcome: "price_needs_decision",
      product: { ...product, bupayment: { ...link, sellable: false } },
    };
  }
  const next: MerchantProduct = {
    ...product,
    pricing: pricingFrom(product.pricing.mode, current, readAt),
    bupayment: {
      productId: remoteProduct.id,
      priceId: current.id,
      sellable: true,
      productUpdatedAt: remoteProduct.updatedAt,
      priceUpdatedAt: current.updatedAt,
    },
  };
  return { outcome: outcomeOf(product, next), product: next };
}

function unsellable(
  product: MerchantProduct,
  link: CatalogueLink,
  outcome: "archived" | "withdrawn",
): LinkSyncResult {
  const next = { ...product, bupayment: { ...link, sellable: false } };
  return { outcome: link.sellable ? outcome : "in_sync", product: next };
}

function outcomeOf(before: MerchantProduct, after: MerchantProduct): LinkOutcome {
  if (before.bupayment?.priceId !== after.bupayment?.priceId) {
    return "repointed";
  }
  const unchanged = JSON.stringify(comparable(before)) === JSON.stringify(comparable(after));
  return unchanged ? "in_sync" : "updated";
}

function comparable(product: MerchantProduct) {
  const pricing = product.pricing;
  const money =
    pricing.mode === "stored"
      ? [pricing.amount, pricing.currency]
      : [pricing.lastKnown?.amount, pricing.lastKnown?.currency];
  const link = product.bupayment;
  return [money, link?.sellable, link?.productUpdatedAt, link?.priceUpdatedAt];
}

function currentPrice(
  product: Product,
  linked: Price | undefined,
  remote: RemoteCatalogue,
): Price | undefined {
  if (linked === undefined) {
    return undefined;
  }
  if (linked.active) {
    return linked;
  }
  const candidates = [...remote.prices.values()].filter(
    (price) => price.productId === product.id && price.active && interchangeable(price, linked),
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

function interchangeable(candidate: Price, linked: Price): boolean {
  return (
    candidate.currency === linked.currency &&
    candidate.type === linked.type &&
    candidate.recurring?.interval === linked.recurring?.interval &&
    candidate.recurring?.intervalCount === linked.recurring?.intervalCount
  );
}

function isStale(link: CatalogueLink, product: Product, price: Price | undefined): boolean {
  if (isOlder(product.updatedAt, link.productUpdatedAt)) {
    return true;
  }
  return price !== undefined && isOlder(price.updatedAt, link.priceUpdatedAt);
}

function latestById<T extends { id: string; updatedAt: string }>(
  rows: readonly T[],
): ReadonlyMap<string, T> {
  const byId = new Map<string, T>();
  for (const row of rows) {
    const known = byId.get(row.id);
    if (known === undefined || isOlder(known.updatedAt, row.updatedAt)) {
      byId.set(row.id, row);
    }
  }
  return byId;
}
