import type { BuPaymentClient, ExpectedPrice, SaleResult } from "@bu-payment/node-sdk";
import { findProduct, isSellable, type MerchantProduct } from "../catalogue/merchant";
import type { CatalogueStore } from "../catalogue/store";
import { apiErrorOf } from "../runtime/errors";
import {
  checkoutOfOrder,
  type HostedCheckoutResult,
  type HostedCheckoutSettings,
  isHostedOrder,
  openHostedCheckout,
} from "./hosted";
import { deferredRelease, heldBy, orderReservation } from "./reservation";

export interface Order {
  orderId: string;
  sku: string;
  email: string;
}

export type CheckoutRefusal =
  | "product_not_found"
  | "not_sellable"
  | "price_unknown"
  | "order_mismatch"
  | "checkout_closed"
  | "checkout_not_configured";

export type CheckoutResult =
  | SaleResult
  | HostedCheckoutResult
  | { outcome: "refused"; reason: CheckoutRefusal };

export async function sell(
  bupayment: Pick<BuPaymentClient, "sales" | "checkout">,
  store: CatalogueStore,
  order: Order,
  hosted: HostedCheckoutSettings | null,
): Promise<CheckoutResult> {
  const catalogue = store.load();
  const product = findProduct(catalogue, order.sku);
  if (product === undefined) {
    return { outcome: "refused", reason: "product_not_found" };
  }
  const link = product.bupayment;
  if (link === null || !isSellable(link)) {
    return { outcome: "refused", reason: "not_sellable" };
  }
  const shown = shownPrice(product);
  if (shown === null) {
    return { outcome: "refused", reason: "price_unknown" };
  }
  const held = heldBy(catalogue, order.orderId);
  if (held !== undefined && held !== order.sku) {
    return { outcome: "refused", reason: "order_mismatch" };
  }
  const placed = checkoutOfOrder(catalogue, order.orderId);
  if (placed !== undefined && (placed.settled !== null || placed.sku !== order.sku)) {
    return {
      outcome: "refused",
      reason: placed.sku === order.sku ? "checkout_closed" : "order_mismatch",
    };
  }
  const reservation = orderReservation(store, order.orderId, product.sku);
  const alreadyHeld = held !== undefined;
  if (placed === undefined && !isHostedOrder(catalogue, order.orderId)) {
    const direct = deferredRelease(reservation);
    try {
      const result = await bupayment.sales
        .draft()
        .priceId(link.priceId)
        .displayedPrice(shown)
        .customerEmail(order.email)
        .reference(product.sku)
        .reservation(direct.reservation)
        .idempotencyKey(`order-${order.orderId}`)
        .charge();
      await direct.flush();
      return result;
    } catch (error) {
      const fallsBack = cannotChargeDirectly(error);
      if (!fallsBack || hosted === null) {
        await direct.flush();
      }
      if (!fallsBack) {
        throw error;
      }
    }
  }
  if (hosted === null) {
    return { outcome: "refused", reason: "checkout_not_configured" };
  }
  return await openHostedCheckout(
    bupayment,
    store,
    { ...order, priceId: link.priceId, shown, alreadyHeld },
    hosted,
  );
}

function cannotChargeDirectly(error: unknown): boolean {
  return apiErrorOf(error) === "provider_capability_not_supported";
}

function shownPrice(product: MerchantProduct): ExpectedPrice | null {
  const pricing = product.pricing;
  if (pricing.mode === "stored") {
    return { unitAmount: pricing.amount, currency: pricing.currency };
  }
  const last = pricing.lastKnown;
  return last === null ? null : { unitAmount: last.amount, currency: last.currency };
}
