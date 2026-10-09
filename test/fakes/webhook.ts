import { createHmac } from "node:crypto";
import type {
  CatalogueEvent,
  CataloguePriceEventType,
  CatalogueProductEventType,
  CheckoutEvent,
  CheckoutStatus,
  Price,
  Product,
  VerifiedWebhookDelivery,
  WebhookEvent,
} from "@bu-payment/node-sdk";

export const WEBHOOK_SECRET = "whsec_Qm9ndXNUZXN0U2VjcmV0Rm9yVGhlUGxheWdyb3VuZDA";

export function productEvent(
  type: CatalogueProductEventType,
  resource: Product,
  options: { id?: string; occurredAt?: string; defaultPriceId?: string | null } = {},
): CatalogueEvent {
  const occurredAt = options.occurredAt ?? resource.updatedAt;
  return {
    version: 1,
    id: options.id ?? `evt_${type}_${resource.id}_${occurredAt}`,
    type,
    occurredAt,
    data: {
      resourceType: "product",
      resourceId: resource.id,
      occurredAt,
      updatedAt: resource.updatedAt,
      resource: { ...resource, defaultPriceId: options.defaultPriceId ?? null },
    },
  } as CatalogueEvent;
}

export function priceEvent(
  type: CataloguePriceEventType,
  resource: Price,
  options: { id?: string; occurredAt?: string } = {},
): CatalogueEvent {
  const occurredAt = options.occurredAt ?? resource.updatedAt;
  return {
    version: 1,
    id: options.id ?? `evt_${type}_${resource.id}_${occurredAt}`,
    type,
    occurredAt,
    data: {
      resourceType: "price",
      resourceId: resource.id,
      occurredAt,
      updatedAt: resource.updatedAt,
      resource,
    },
  } as CatalogueEvent;
}

export function checkoutEvent(
  type: CheckoutEvent["type"],
  options: {
    id?: string;
    checkoutId?: string;
    reference?: string | null;
    previousStatus?: CheckoutStatus;
  } = {},
): CheckoutEvent {
  const checkoutId = options.checkoutId ?? "chk_1";
  const occurredAt = "2026-10-09T12:00:00.000Z";
  const common = {
    checkoutId,
    reference: options.reference === undefined ? "A1" : options.reference,
    provider: "trust-my-travel",
    providerCheckoutId: `tmt_${checkoutId}`,
    previousStatus: options.previousStatus ?? "pending",
  };
  const status = type.slice("checkout.".length);
  const data =
    type === "checkout.cancelled"
      ? common
      : {
          ...common,
          status,
          paymentId: type === "checkout.completed" ? "pay_1" : null,
          amount: 2750,
          currency: "EUR",
          chargedAmount: type === "checkout.completed" ? 2750 : null,
          chargedCurrency: type === "checkout.completed" ? "EUR" : null,
          quantity: 1,
          customerId: "cus_1",
        };
  return {
    version: 1,
    id: options.id ?? `evt_${type}_${checkoutId}`,
    type,
    occurredAt,
    data,
  } as CheckoutEvent;
}

export function verified(
  event: WebhookEvent,
  deliveryId = `dlv_${event.id}`,
): VerifiedWebhookDelivery {
  return { deliveryId, signature: "unused", timestamp: new Date(), event };
}

export function signed(
  envelope: unknown,
  options: { deliveryId?: string; timestamp?: number; secret?: string; body?: string } = {},
) {
  const body = options.body ?? JSON.stringify(envelope);
  const timestamp = String(options.timestamp ?? Date.now());
  const signature = createHmac("sha256", options.secret ?? WEBHOOK_SECRET)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return {
    body,
    headers: {
      "content-type": "application/json",
      "x-webhook-id": options.deliveryId ?? "dlv_1",
      "x-webhook-timestamp": timestamp,
      "x-webhook-signature": signature,
    },
  };
}
