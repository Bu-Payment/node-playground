import type { Price, Product } from "@bu-payment/node-sdk";
import {
  type CatalogueLink,
  isOlder,
  type MerchantProduct,
  type PriceTerms,
  pointToPrice,
  pricingFrom,
  termsOfLink,
  termsOfPrice,
} from "./merchant";

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
    return settle(product, observeProductAssignment(link, false, readAt), false);
  }
  const linkedPrice = remote.prices.get(link.priceId);
  if (isStale(link, remoteProduct, linkedPrice)) {
    return { outcome: "stale", product };
  }
  const observed: CatalogueLink = {
    ...observeProductAssignment(link, true, readAt),
    productActive: remoteProduct.active,
    productUpdatedAt: remoteProduct.updatedAt,
  };
  if (linkedPrice === undefined && overtaken(link.priceAssignmentAt, readAt)) {
    return settle(product, observed, false);
  }
  const linkedAssigned = linkedPrice !== undefined && options.unassignedPriceId !== linkedPrice.id;
  const defaultPriceId = options.defaultPriceId ?? remoteProduct.defaultPriceId ?? null;
  const current = currentPrice(
    link,
    remoteProduct,
    linkedPrice,
    linkedAssigned,
    remote,
    defaultPriceId,
  );
  if (current === undefined) {
    const awaitingPriceDecision = remoteProduct.active;
    return settle(
      product,
      withLinkedPrice(observed, linkedPrice, linkedAssigned, readAt),
      awaitingPriceDecision,
    );
  }
  const bupayment =
    current.id === link.priceId
      ? withLinkedPrice(observed, current, true, readAt)
      : pointToPrice(observed, current, readAt);
  const next: MerchantProduct = {
    ...product,
    pricing: pricingFrom(product.pricing.mode, current, readAt),
    bupayment,
  };
  return { outcome: outcomeOf(product, next), product: next };
}

function withLinkedPrice(
  link: CatalogueLink,
  linked: Price | undefined,
  assigned: boolean,
  observedAt: string,
): CatalogueLink {
  if (linked === undefined || !assigned) {
    return observePriceAssignment(link, false, observedAt);
  }
  const terms = termsOfPrice(linked);
  return {
    ...observePriceAssignment(link, true, observedAt),
    priceActive: linked.active,
    priceUpdatedAt: linked.updatedAt,
    priceCurrency: terms.currency,
    priceType: terms.type,
    priceInterval: terms.interval,
    priceIntervalCount: terms.intervalCount,
  };
}

function observeProductAssignment(
  link: CatalogueLink,
  assigned: boolean,
  observedAt: string,
): CatalogueLink {
  if (overtaken(link.productAssignmentAt, observedAt) || link.productAssigned === assigned) {
    return link;
  }
  return { ...link, productAssigned: assigned, productAssignmentAt: observedAt };
}

function observePriceAssignment(
  link: CatalogueLink,
  assigned: boolean,
  observedAt: string,
): CatalogueLink {
  if (overtaken(link.priceAssignmentAt, observedAt) || link.priceAssigned === assigned) {
    return link;
  }
  return { ...link, priceAssigned: assigned, priceAssignmentAt: observedAt };
}

function overtaken(lastAssignmentAt: string | null, observedAt: string): boolean {
  return lastAssignmentAt !== null && isOlder(observedAt, lastAssignmentAt);
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
  link: CatalogueLink,
  product: Product,
  linked: Price | undefined,
  linkedAssigned: boolean,
  remote: RemoteCatalogue,
  defaultPriceId: string | null,
): Price | undefined {
  if (linked?.active === true && linkedAssigned) {
    return linked;
  }
  const terms = linked === undefined ? termsOfLink(link) : termsOfPrice(linked);
  if (terms === undefined) {
    return undefined;
  }
  const candidates = [...remote.prices.values()].filter(
    (price) =>
      price.id !== link.priceId &&
      price.productId === product.id &&
      price.active &&
      interchangeable(termsOfPrice(price), terms),
  );
  const preferred = candidates.find((price) => price.id === defaultPriceId);
  if (preferred !== undefined) {
    return preferred;
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

function interchangeable(candidate: PriceTerms, linked: PriceTerms): boolean {
  return (
    candidate.currency === linked.currency &&
    candidate.type === linked.type &&
    candidate.interval === linked.interval &&
    candidate.intervalCount === linked.intervalCount
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
