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

export interface SyncOptions {
  defaultPriceId?: string | null;
  unassignedPriceId?: string;
}

export function syncLink(
  product: MerchantProduct,
  remote: RemoteCatalogue,
  readAt: string,
  options: SyncOptions = {},
): LinkSyncResult {
  const link = product.bupayment;
  if (link === null) {
    return { outcome: "in_sync", product };
  }
  const remoteProduct = remote.products.get(link.productId);
  if (remoteProduct === undefined) {
    return settle(product, { ...link, productAssigned: false }, false);
  }
  const linkedPrice = remote.prices.get(link.priceId);
  if (isStale(link, remoteProduct, linkedPrice)) {
    return { outcome: "stale", product };
  }
  const observed: CatalogueLink = {
    ...link,
    productAssigned: true,
    productActive: remoteProduct.active,
    productUpdatedAt: remoteProduct.updatedAt,
  };
  const linkedAssigned = linkedPrice !== undefined && options.unassignedPriceId !== linkedPrice.id;
  const current = currentPrice(
    remoteProduct,
    linkedPrice,
    linkedAssigned,
    remote,
    options.defaultPriceId ?? null,
  );
  if (current === undefined) {
    const awaitingPriceDecision = remoteProduct.active;
    return settle(
      product,
      withLinkedPrice(observed, linkedPrice, linkedAssigned),
      awaitingPriceDecision,
    );
  }
  const next: MerchantProduct = {
    ...product,
    pricing: pricingFrom(product.pricing.mode, current, readAt),
    bupayment: {
      ...observed,
      priceId: current.id,
      priceActive: true,
      priceAssigned: true,
      priceUpdatedAt: current.updatedAt,
    },
  };
  return { outcome: outcomeOf(product, next), product: next };
}

function withLinkedPrice(
  link: CatalogueLink,
  linked: Price | undefined,
  assigned: boolean,
): CatalogueLink {
  if (linked === undefined || !assigned) {
    return { ...link, priceAssigned: false };
  }
  return {
    ...link,
    priceAssigned: true,
    priceActive: linked.active,
    priceUpdatedAt: linked.updatedAt,
  };
}

function settle(
  product: MerchantProduct,
  link: CatalogueLink,
  needsDecision: boolean,
): LinkSyncResult {
  const next = { ...product, bupayment: link };
  return {
    outcome: needsDecision ? "price_needs_decision" : outcomeOf(product, next),
    product: next,
  };
}

function outcomeOf(before: MerchantProduct, after: MerchantProduct): LinkOutcome {
  const was = before.bupayment;
  const is = after.bupayment;
  if (was?.productAssigned === true && is?.productAssigned === false) {
    return "withdrawn";
  }
  if (was?.productActive === true && is?.productActive === false) {
    return "archived";
  }
  if (was?.priceId !== is?.priceId) {
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
  return [
    money,
    link?.productActive,
    link?.priceActive,
    link?.productAssigned,
    link?.priceAssigned,
    link?.productUpdatedAt,
    link?.priceUpdatedAt,
  ];
}

function currentPrice(
  product: Product,
  linked: Price | undefined,
  linkedAssigned: boolean,
  remote: RemoteCatalogue,
  defaultPriceId: string | null,
): Price | undefined {
  if (linked === undefined) {
    return undefined;
  }
  if (linked.active && linkedAssigned) {
    return linked;
  }
  const candidates = [...remote.prices.values()].filter(
    (price) =>
      price.id !== linked.id &&
      price.productId === product.id &&
      price.active &&
      interchangeable(price, linked),
  );
  const preferred = candidates.find((price) => price.id === defaultPriceId);
  if (preferred !== undefined) {
    return preferred;
  }
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
