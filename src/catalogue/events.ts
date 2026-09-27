import type {
  CatalogueEvent,
  CataloguePriceEvent,
  CatalogueProductEvent,
} from "@bu-payment/node-sdk";
import {
  type CatalogueLink,
  isOlder,
  isSellable,
  type MerchantProduct,
  pricingFrom,
} from "./merchant";

export type EventOutcome = "applied" | "stale" | "unrelated";

export interface EventApplication {
  outcome: EventOutcome;
  product: MerchantProduct;
  needsReplacementPrice: boolean;
}

type Applied = MerchantProduct | "stale" | "unrelated";

const ASSIGNMENTS: Readonly<Record<string, boolean>> = {
  "catalogue.product.assigned.v1": true,
  "catalogue.product.unassigned.v1": false,
  "catalogue.price.assigned.v1": true,
  "catalogue.price.unassigned.v1": false,
};

export function applyCatalogueEvent(
  product: MerchantProduct,
  event: CatalogueEvent,
  receivedAt: string,
): EventApplication {
  const link = product.bupayment;
  if (link === null) {
    return { outcome: "unrelated", product, needsReplacementPrice: false };
  }
  const applied = isProductEvent(event)
    ? applyProductEvent(product, link, event)
    : applyPriceEvent(product, link, event, receivedAt);
  if (applied === "stale") {
    return { outcome: "stale", product, needsReplacementPrice: false };
  }
  if (applied === "unrelated") {
    return { outcome: "unrelated", product, needsReplacementPrice: offersReplacement(link, event) };
  }
  return {
    outcome: "applied",
    product: applied,
    needsReplacementPrice: awaitsPrice(applied.bupayment),
  };
}

export function defaultPriceIdOf(event: CatalogueEvent): string | null {
  return isProductEvent(event) ? event.data.resource.defaultPriceId : null;
}

function applyProductEvent(
  product: MerchantProduct,
  link: CatalogueLink,
  event: CatalogueProductEvent,
): Applied {
  if (event.data.resourceId !== link.productId) {
    return "unrelated";
  }
  const assigned = ASSIGNMENTS[event.type];
  if (assigned !== undefined && isOlderAssignment(event.occurredAt, link.productAssignmentAt)) {
    return "stale";
  }
  const withAssignment: CatalogueLink =
    assigned === undefined
      ? link
      : { ...link, productAssigned: assigned, productAssignmentAt: event.occurredAt };
  const resource = event.data.resource;
  if (isOlder(resource.updatedAt, link.productUpdatedAt)) {
    return assigned === undefined ? "stale" : { ...product, bupayment: withAssignment };
  }
  return {
    ...product,
    bupayment: {
      ...withAssignment,
      productActive: resource.active,
      productUpdatedAt: resource.updatedAt,
    },
  };
}

function applyPriceEvent(
  product: MerchantProduct,
  link: CatalogueLink,
  event: CataloguePriceEvent,
  receivedAt: string,
): Applied {
  if (event.data.resourceId !== link.priceId) {
    return "unrelated";
  }
  const assigned = ASSIGNMENTS[event.type];
  if (assigned !== undefined && isOlderAssignment(event.occurredAt, link.priceAssignmentAt)) {
    return "stale";
  }
  const withAssignment: CatalogueLink =
    assigned === undefined
      ? link
      : { ...link, priceAssigned: assigned, priceAssignmentAt: event.occurredAt };
  const resource = event.data.resource;
  if (isOlder(resource.updatedAt, link.priceUpdatedAt)) {
    return assigned === undefined ? "stale" : { ...product, bupayment: withAssignment };
  }
  return {
    ...product,
    pricing: pricingFrom(product.pricing.mode, resource, receivedAt),
    bupayment: {
      ...withAssignment,
      priceActive: resource.active,
      priceUpdatedAt: resource.updatedAt,
    },
  };
}

function isOlderAssignment(occurredAt: string, lastAssignmentAt: string | null): boolean {
  return lastAssignmentAt !== null && isOlder(occurredAt, lastAssignmentAt);
}

function offersReplacement(link: CatalogueLink, event: CatalogueEvent): boolean {
  return (
    !isProductEvent(event) &&
    event.data.resource.productId === link.productId &&
    event.data.resource.active &&
    awaitsPrice(link)
  );
}

function awaitsPrice(link: CatalogueLink | null): boolean {
  if (link === null) {
    return false;
  }
  return link.productActive && link.productAssigned && !isSellable(link);
}

function isProductEvent(event: CatalogueEvent): event is CatalogueProductEvent {
  return event.data.resourceType === "product";
}
