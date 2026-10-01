import type { BuPaymentClient, ExpectedPrice, SaleResult } from "@bu-payment/node-sdk";
import { findProduct, isSellable, type MerchantProduct } from "../catalogue/merchant";
import type { CatalogueStore } from "../catalogue/store";
import { heldBy, orderReservation } from "./reservation";

export interface Order {
  orderId: string;
  sku: string;
  email: string;
}

export type CheckoutRefusal =
  | "product_not_found"
  | "not_sellable"
  | "price_unknown"
  | "order_mismatch";

export type CheckoutResult = SaleResult | { outcome: "refused"; reason: CheckoutRefusal };

export async function sell(
  bupayment: Pick<BuPaymentClient, "sales">,
  store: CatalogueStore,
  order: Order,
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
  return await bupayment.sales
    .draft()
    .priceId(link.priceId)
    .displayedPrice(shown)
    .customerEmail(order.email)
    .reference(product.sku)
    .reservation(orderReservation(store, order.orderId, product.sku))
    .idempotencyKey(`order-${order.orderId}`)
    .charge();
}

function shownPrice(product: MerchantProduct): ExpectedPrice | null {
  const pricing = product.pricing;
  if (pricing.mode === "stored") {
    return { unitAmount: pricing.amount, currency: pricing.currency };
  }
  const last = pricing.lastKnown;
  return last === null ? null : { unitAmount: last.amount, currency: last.currency };
}
