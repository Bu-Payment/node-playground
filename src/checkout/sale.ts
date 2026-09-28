import {
  type BuPaymentClient,
  BuPaymentError,
  ErrorCode,
  type Payment,
} from "@bu-payment/node-sdk";
import { findProduct, isSellable, type MerchantProduct } from "../catalogue/merchant";
import { type CatalogueStore, updateProduct } from "../catalogue/store";
import { customerFor } from "./customer";

export interface Order {
  sku: string;
  email: string;
}

export interface Money {
  amount: number;
  currency: string;
}

export type SaleRefusal = "product_not_found" | "not_sellable" | "price_unknown" | "out_of_stock";

export type SaleResult =
  | { sold: true; payment: Payment; stock: number }
  | { sold: false; reason: SaleRefusal }
  | { sold: false; reason: "price_changed"; shown: Money; current: Money | null };

export async function sell(
  bupayment: Pick<BuPaymentClient, "customers" | "payments">,
  store: CatalogueStore,
  order: Order,
): Promise<SaleResult> {
  const product = findProduct(store.load(), order.sku);
  if (product === undefined) {
    return { sold: false, reason: "product_not_found" };
  }
  const link = product.bupayment;
  if (link === null || !isSellable(link)) {
    return { sold: false, reason: "not_sellable" };
  }
  const shown = shownPrice(product);
  if (shown === null) {
    return { sold: false, reason: "price_unknown" };
  }
  if (product.stock === 0) {
    return { sold: false, reason: "out_of_stock" };
  }
  const customer = await customerFor(bupayment.customers, order.email);
  let payment: Payment;
  try {
    payment = await bupayment.payments
      .draft()
      .customerId(customer.id)
      .priceId(link.priceId)
      .expectedPrice({ unitAmount: shown.amount, currency: shown.currency })
      .reference(product.sku)
      .create();
  } catch (error) {
    if (error instanceof BuPaymentError && error.code === ErrorCode.PRICE_CHANGED) {
      const current = error.price;
      return {
        sold: false,
        reason: "price_changed",
        shown,
        current:
          current === undefined ? null : { amount: current.unitAmount, currency: current.currency },
      };
    }
    throw error;
  }
  return { sold: true, payment, stock: settleStock(store, product, payment) };
}

function shownPrice(product: MerchantProduct): Money | null {
  const pricing = product.pricing;
  if (pricing.mode === "stored") {
    return { amount: pricing.amount, currency: pricing.currency };
  }
  const last = pricing.lastKnown;
  return last === null ? null : { amount: last.amount, currency: last.currency };
}

function settleStock(store: CatalogueStore, sold: MerchantProduct, payment: Payment): number {
  if (payment.status !== "succeeded") {
    return sold.stock;
  }
  const updated = updateProduct(store, sold.sku, (current) => ({
    ...current,
    stock: Math.max(current.stock - 1, 0),
  }));
  return updated?.stock ?? 0;
}
