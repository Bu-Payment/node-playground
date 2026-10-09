import {
  BuPaymentError,
  type CatalogueClient,
  type CatalogueEvent,
  type Price,
  type Product,
  type VerifiedWebhookDelivery,
} from "@bu-payment/node-sdk";
import { isCheckoutEvent, type SettlementOutcome, settleCheckout } from "../checkout/settlement";
import { collect } from "./collect";
import { applyCatalogueEvent, defaultPriceIdOf } from "./events";
import { indexRemote, type LinkOutcome, syncLink } from "./link-sync";
import {
  type CatalogueLink,
  defineOwnKey,
  findProduct,
  type MerchantCatalogue,
  type MerchantProduct,
  putProduct,
} from "./merchant";
import { type CatalogueStore, updateProduct } from "./store";

export type ReplacementOutcome = LinkOutcome | "unreachable" | "superseded";

export interface DeliveryReport {
  outcome: "duplicate" | "ignored" | "applied";
  applied: string[];
  stale: string[];
  replacements: { sku: string; outcome: ReplacementOutcome }[];
  unlinked: string[];
  settlement?: SettlementOutcome;
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
  const report: DeliveryReport = {
    outcome: "applied",
    applied: [],
    stale: [],
    replacements: [],
    unlinked: [],
  };
  if (seen || event.type === "unknown") {
    store.save(local);
    return { ...report, outcome: seen ? "duplicate" : "ignored" };
  }
  if (isCheckoutEvent(event)) {
    const settlement = settleCheckout(local, event);
    store.save(local);
    return { ...report, settlement };
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
  if (event.type === "catalogue.product.assigned.v1" && !isLinked(local, event.data.resourceId)) {
    report.unlinked.push(event.data.resourceId);
  }
  store.save(local);
  const reads = new Map<string, Promise<ProductReads | undefined>>();
  for (const sku of awaiting) {
    const product = findProduct(local, sku);
    const link = product?.bupayment ?? null;
    if (product === undefined || link === null) {
      continue;
    }
    const pending = reads.get(link.productId) ?? readProduct(catalogue, link.productId);
    reads.set(link.productId, pending);
    report.replacements.push({
      sku,
      outcome: await repointAfterEvent(store, product, link, await pending, event, receivedAt),
    });
  }
  return report;
}

interface ProductReads {
  product: Product | undefined;
  prices: Price[];
}

async function repointAfterEvent(
  store: CatalogueStore,
  product: MerchantProduct,
  link: CatalogueLink,
  reads: ProductReads | undefined,
  event: CatalogueEvent,
  readAt: string,
): Promise<ReplacementOutcome> {
  if (reads === undefined) {
    return "unreachable";
  }
  const readable = reads.prices.some((price) => price.id === link.priceId);
  const unassigned = readable ? undefined : unassignedLinkedPrice(event, link.priceId);
  const remote = indexRemote(
    reads.product === undefined ? [] : [reads.product],
    unassigned === undefined ? reads.prices : [unassigned, ...reads.prices],
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

async function readProduct(
  catalogue: CatalogueClient,
  productId: string,
): Promise<ProductReads | undefined> {
  try {
    const product = await catalogue.product(productId).get().catch(onlyNotFound);
    if (product === undefined) {
      return { product, prices: [] };
    }
    const prices = await collect(
      catalogue.prices().productId(productId).active(true).all(),
      catalogue.prices().productId(productId).active(false).all(),
    );
    return { product, prices };
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

function isLinked(catalogue: MerchantCatalogue, productId: string): boolean {
  return Object.values(catalogue.products).some(
    (product) => product.bupayment?.productId === productId,
  );
}

function record(ids: Record<string, string>, id: string, at: string): void {
  if (!Object.hasOwn(ids, id)) {
    defineOwnKey(ids, id, at);
  }
}
