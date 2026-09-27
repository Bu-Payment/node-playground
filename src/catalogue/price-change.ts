import type { CatalogueClient, Price, PriceChange } from "@bu-payment/node-sdk";
import {
  type CatalogueLink,
  findProduct,
  type MerchantProduct,
  pointToPrice,
  pricingFrom,
} from "./merchant";
import { type CatalogueStore, updateProduct } from "./store";

export type FailedArchive = Extract<PriceChange, { outcome: "archive_failed" }>;

export interface OrphanedPrice {
  priceId: string;
  archived: boolean;
  error: unknown;
}

export type PriceChangeResult =
  | { changed: true; product: MerchantProduct; archivePending: FailedArchive | null }
  | { changed: false; reason: "product_not_found" }
  | { changed: false; reason: "product_changed"; orphan: OrphanedPrice | null };

export async function changePrice(
  catalogue: CatalogueClient,
  store: CatalogueStore,
  sku: string,
  amount: number,
  now: () => Date = () => new Date(),
): Promise<PriceChangeResult> {
  const local = findProduct(store.load(), sku);
  if (local === undefined) {
    return { changed: false, reason: "product_not_found" };
  }
  const link = local.bupayment;
  if (link === null) {
    return changeLocalPrice(store, sku, amount);
  }
  const change = await replacePrice(
    catalogue,
    link,
    amount,
    `price-change:${sku}:${link.priceId}:${link.priceAssignmentAt ?? "unrecorded"}:${amount}`,
  );
  const readAt = now().toISOString();
  const replacement = change.replacement;
  const product = updateProduct(store, sku, (current) => {
    const currentLink = current.bupayment;
    if (currentLink === null || ![link.priceId, replacement.id].includes(currentLink.priceId)) {
      return undefined;
    }
    return {
      ...current,
      pricing: pricingFrom(current.pricing.mode, replacement, readAt),
      bupayment: pointToPrice(currentLink, replacement, readAt),
    };
  });
  if (product === undefined) {
    return {
      changed: false,
      reason: "product_changed",
      orphan: await archiveOrphan(catalogue, replacement),
    };
  }
  return {
    changed: true,
    product,
    archivePending: change.outcome === "archive_failed" ? change : null,
  };
}

function changeLocalPrice(store: CatalogueStore, sku: string, amount: number): PriceChangeResult {
  const product = updateProduct(store, sku, (current) =>
    current.pricing.mode === "stored" && current.bupayment === null
      ? { ...current, pricing: { ...current.pricing, amount } }
      : undefined,
  );
  return product === undefined
    ? { changed: false, reason: "product_changed", orphan: null }
    : { changed: true, product, archivePending: null };
}

async function archiveOrphan(catalogue: CatalogueClient, price: Price): Promise<OrphanedPrice> {
  try {
    await catalogue.archivePrice(price.id).expectedUpdatedAt(price.updatedAt).archive();
    return { priceId: price.id, archived: true, error: null };
  } catch (error) {
    return { priceId: price.id, archived: false, error };
  }
}

async function replacePrice(
  catalogue: CatalogueClient,
  link: CatalogueLink,
  amount: number,
  idempotencyKey: string,
): Promise<PriceChange> {
  const current: Price = await catalogue.price(link.priceId).get();
  const draft = catalogue
    .priceDraft(link.productId)
    .idempotencyKey(idempotencyKey)
    .unitAmount(amount)
    .currency(current.currency);
  if (current.recurring === null) {
    return await draft.replacing(link.priceId).expectedUpdatedAt(link.priceUpdatedAt).replace();
  }
  return await draft
    .interval(current.recurring.interval)
    .intervalCount(current.recurring.intervalCount)
    .replacing(link.priceId)
    .expectedUpdatedAt(link.priceUpdatedAt)
    .replace();
}
