import {
  BuPaymentError,
  type CatalogueClient,
  type CatalogueEvent,
  type Price,
  type VerifiedWebhookDelivery,
} from "@bu-payment/node-sdk";
import { applyCatalogueEvent, defaultPriceIdOf } from "./events";
import { indexRemote, type LinkOutcome, syncLink } from "./link-sync";
import { defineOwnKey, findProduct, type MerchantProduct, putProduct } from "./merchant";
import { type CatalogueStore, updateProduct } from "./store";

export type ReplacementOutcome = LinkOutcome | "unreachable" | "superseded";

export interface DeliveryReport {
  outcome: "duplicate" | "ignored" | "applied";
  applied: string[];
  stale: string[];
  replacements: { sku: string; outcome: ReplacementOutcome }[];
}

export async function receiveDelivery(
  catalogue: CatalogueClient,
  store: CatalogueStore,
  delivery: VerifiedWebhookDelivery,
  now: () => Date = () => new Date(),
): Promise<DeliveryReport> {
  const receivedAt = now().toISOString();
  const local = store.load();
  const event = delivery.event;
  const seen =
    Object.hasOwn(local.received.deliveries, delivery.deliveryId) ||
    Object.hasOwn(local.received.events, event.id);
  record(local.received.deliveries, delivery.deliveryId, receivedAt);
  record(local.received.events, event.id, receivedAt);
  const report: DeliveryReport = { outcome: "applied", applied: [], stale: [], replacements: [] };
  if (seen || event.type === "unknown") {
    store.save(local);
    return { ...report, outcome: seen ? "duplicate" : "ignored" };
  }
  const awaiting: string[] = [];
  for (const product of Object.values(local.products)) {
    const application = applyCatalogueEvent(product, event, receivedAt);
    putProduct(local, application.product);
    if (application.outcome === "applied") {
      report.applied.push(product.sku);
    }
    if (application.outcome === "stale") {
      report.stale.push(product.sku);
    }
    if (application.needsReplacementPrice) {
      awaiting.push(product.sku);
    }
  }
  store.save(local);
  for (const sku of awaiting) {
    const product = findProduct(local, sku);
    if (product !== undefined) {
      report.replacements.push({
        sku,
        outcome: await replacePrice(catalogue, store, product, event, receivedAt),
      });
    }
  }
  return report;
}

async function replacePrice(
  catalogue: CatalogueClient,
  store: CatalogueStore,
  product: MerchantProduct,
  event: CatalogueEvent,
  readAt: string,
): Promise<ReplacementOutcome> {
  const link = product.bupayment;
  if (link === null) {
    return "in_sync";
  }
  const reads = await readProductPrices(catalogue, link.productId, link.priceId);
  if (reads === undefined) {
    return "unreachable";
  }
  const unassigned =
    reads.linked === undefined ? unassignedLinkedPrice(event, link.priceId) : undefined;
  const linked = reads.linked ?? unassigned;
  const remote = indexRemote(
    [reads.product],
    linked === undefined ? reads.active : [linked, ...reads.active],
  );
  const options = {
    defaultPriceId: defaultPriceIdOf(event),
    ...(unassigned === undefined ? {} : { unassignedPriceId: unassigned.id }),
  };
  const before = JSON.stringify(link);
  let outcome: ReplacementOutcome = "superseded";
  updateProduct(store, product.sku, (current) => {
    if (JSON.stringify(current.bupayment) !== before) {
      return undefined;
    }
    const result = syncLink(current, remote, readAt, options);
    outcome = result.outcome;
    return result.product;
  });
  return outcome;
}

function unassignedLinkedPrice(event: CatalogueEvent, linkedPriceId: string): Price | undefined {
  const data = event.data;
  return data.resourceType === "price" && data.resourceId === linkedPriceId
    ? data.resource
    : undefined;
}

async function readProductPrices(
  catalogue: CatalogueClient,
  productId: string,
  linkedPriceId: string,
) {
  try {
    const [product, linked, active] = await Promise.all([
      catalogue.product(productId).get(),
      catalogue.price(linkedPriceId).get().catch(onlyNotFound),
      collect(catalogue.prices().productId(productId).active(true).all()),
    ]);
    return { product, linked, active };
  } catch {
    return undefined;
  }
}

function onlyNotFound(error: unknown): undefined {
  if (error instanceof BuPaymentError && error.status === 404) {
    return undefined;
  }
  throw error;
}

async function collect(walk: AsyncGenerator<Price, void, undefined>): Promise<Price[]> {
  const prices: Price[] = [];
  for await (const price of walk) {
    prices.push(price);
  }
  return prices;
}

function record(ids: Record<string, string>, id: string, at: string): void {
  if (!Object.hasOwn(ids, id)) {
    defineOwnKey(ids, id, at);
  }
}
