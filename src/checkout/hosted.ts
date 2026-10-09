import {
  type BuPaymentClient,
  BuPaymentError,
  type Checkout,
  type CurrentPrice,
  type ExpectedPrice,
  isPriceChanged,
} from "@bu-payment/node-sdk";
import { defineOwnKey, type MerchantCatalogue, type OrderCheckout } from "../catalogue/merchant";
import type { CatalogueStore } from "../catalogue/store";
import { apiErrorOf } from "../runtime/errors";
import { orderReservation } from "./reservation";

export interface HostedCheckoutSettings {
  destination: string;
  provider: string | null;
}

export interface HostedOrder {
  orderId: string;
  sku: string;
  email: string;
  priceId: string;
  shown: ExpectedPrice;
}

export type HostedCheckoutResult =
  | { outcome: "checkout_open"; checkout: Checkout }
  | { outcome: "checkout_refused"; error: BuPaymentError }
  | { outcome: "price_changed"; shown: ExpectedPrice; current: CurrentPrice | null }
  | { outcome: "unconfirmed"; error: BuPaymentError }
  | { outcome: "unavailable" };

const DEFINITE_REFUSALS = new Set(["checkout_unavailable", "checkout_provider_failed"]);

export async function openHostedCheckout(
  bupayment: Pick<BuPaymentClient, "checkout">,
  store: CatalogueStore,
  order: HostedOrder,
  settings: HostedCheckoutSettings,
): Promise<HostedCheckoutResult> {
  const reservation = orderReservation(store, order.orderId, order.sku);
  if (!(await reservation.reserve())) {
    return { outcome: "unavailable" };
  }
  const alreadyOpen = checkoutOfOrder(store.load(), order.orderId) !== undefined;
  let checkout: Checkout;
  try {
    checkout = await createCheckout(bupayment, order, settings);
  } catch (error) {
    if (!(error instanceof BuPaymentError)) {
      throw error;
    }
    if (mayHaveBeenCreated(error)) {
      return { outcome: "unconfirmed", error };
    }
    if (!alreadyOpen) {
      await reservation.release();
    }
    if (isPriceChanged(error)) {
      return { outcome: "price_changed", shown: order.shown, current: error.price ?? null };
    }
    return { outcome: "checkout_refused", error };
  }
  recordCheckout(store, checkout.id, { orderId: order.orderId, sku: order.sku, settled: null });
  return { outcome: "checkout_open", checkout };
}

export function checkoutOfOrder(
  catalogue: MerchantCatalogue,
  orderId: string,
): OrderCheckout | undefined {
  return Object.values(catalogue.checkouts).find((placed) => placed.orderId === orderId);
}

async function createCheckout(
  bupayment: Pick<BuPaymentClient, "checkout">,
  order: HostedOrder,
  settings: HostedCheckoutSettings,
): Promise<Checkout> {
  const draft = bupayment.checkout
    .sessionDraft()
    .priceId(order.priceId)
    .expectedPrice(order.shown)
    .customerEmail(order.email)
    .destination(settings.destination)
    .reference(order.orderId)
    .idempotencyKey(order.orderId);
  return await (settings.provider === null ? draft : draft.provider(settings.provider)).create();
}

function mayHaveBeenCreated(error: BuPaymentError): boolean {
  const apiError = apiErrorOf(error);
  if (apiError !== null && DEFINITE_REFUSALS.has(apiError)) {
    return false;
  }
  return (
    error.status === undefined || error.status >= 500 || apiError === "idempotency_in_progress"
  );
}

function recordCheckout(store: CatalogueStore, checkoutId: string, placed: OrderCheckout): void {
  const catalogue = store.load();
  if (Object.hasOwn(catalogue.checkouts, checkoutId)) {
    return;
  }
  defineOwnKey(catalogue.checkouts, checkoutId, placed);
  store.save(catalogue);
}
