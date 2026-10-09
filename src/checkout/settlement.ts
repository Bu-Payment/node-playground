import type { CheckoutEvent, WebhookEvent } from "@bu-payment/node-sdk";
import {
  defineOwnKey,
  findProduct,
  type MerchantCatalogue,
  type OrderCheckout,
  putProduct,
} from "../catalogue/merchant";
import { checkoutOfOrder } from "./hosted";
import { heldBy, keepHeldUnit, returnHeldUnit } from "./reservation";

export type SettlementOutcome =
  | "sold"
  | "released"
  | "oversold"
  | "already_settled"
  | "reference_mismatch"
  | "unknown_checkout";

export function movedStock(outcome: SettlementOutcome): boolean {
  return outcome === "sold" || outcome === "released" || outcome === "oversold";
}

export function isCheckoutEvent(event: WebhookEvent): event is CheckoutEvent {
  return event.type.startsWith("checkout.");
}

export function settleCheckout(
  catalogue: MerchantCatalogue,
  event: CheckoutEvent,
): SettlementOutcome {
  const { checkoutId, reference } = event.data;
  const placed = placedCheckout(catalogue, checkoutId, reference);
  if (placed === undefined) {
    return "unknown_checkout";
  }
  if (reference !== null && reference !== placed.orderId) {
    return "reference_mismatch";
  }
  if (event.type === "checkout.completed") {
    return sellUnit(catalogue, checkoutId, placed);
  }
  if (placed.settled !== null) {
    return "already_settled";
  }
  returnHeldUnit(catalogue, placed.orderId, placed.sku);
  settle(catalogue, checkoutId, placed, "released");
  return "released";
}

function sellUnit(
  catalogue: MerchantCatalogue,
  checkoutId: string,
  placed: OrderCheckout,
): SettlementOutcome {
  if (placed.settled === "sold") {
    return "already_settled";
  }
  settle(catalogue, checkoutId, placed, "sold");
  if (keepHeldUnit(catalogue, placed.orderId, placed.sku)) {
    return "sold";
  }
  const product = findProduct(catalogue, placed.sku);
  if (product === undefined || product.stock === 0) {
    return "oversold";
  }
  putProduct(catalogue, { ...product, stock: product.stock - 1 });
  return "sold";
}

function placedCheckout(
  catalogue: MerchantCatalogue,
  checkoutId: string,
  reference: string | null,
): OrderCheckout | undefined {
  if (Object.hasOwn(catalogue.checkouts, checkoutId)) {
    return catalogue.checkouts[checkoutId];
  }
  const sku = reference === null ? undefined : heldBy(catalogue, reference);
  if (
    reference === null ||
    sku === undefined ||
    checkoutOfOrder(catalogue, reference) !== undefined
  ) {
    return undefined;
  }
  const adopted: OrderCheckout = { orderId: reference, sku, settled: null };
  defineOwnKey(catalogue.checkouts, checkoutId, adopted);
  return adopted;
}

function settle(
  catalogue: MerchantCatalogue,
  checkoutId: string,
  placed: OrderCheckout,
  settled: OrderCheckout["settled"],
): void {
  defineOwnKey(catalogue.checkouts, checkoutId, { ...placed, settled });
}
