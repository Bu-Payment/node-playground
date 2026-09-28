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
  const reserved = updateProduct(store, product.sku, (current) =>
    current.stock > 0 ? { ...current, stock: current.stock - 1 } : undefined,
  );
  if (reserved === undefined) {
    return { sold: false, reason: "out_of_stock" };
  }
  let payment: Payment;
  try {
    payment = await charge(bupayment, order.email, link.priceId, shown, product.sku);
  } catch (error) {
    release(store, product.sku);
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
  const stock = payment.status === "succeeded" ? reserved.stock : release(store, product.sku);
  return { sold: true, payment, stock };
}

async function charge(
  bupayment: Pick<BuPaymentClient, "customers" | "payments">,
  email: string,
  priceId: string,
  shown: Money,
  sku: string,
): Promise<Payment> {
  const customer = await customerFor(bupayment.customers, email);
  return bupayment.payments
    .draft()
    .customerId(customer.id)
    .priceId(priceId)
    .expectedPrice({ unitAmount: shown.amount, currency: shown.currency })
    .reference(sku)
    .create();
}

function shownPrice(product: MerchantProduct): Money | null {
  const pricing = product.pricing;
  if (pricing.mode === "stored") {
    return { amount: pricing.amount, currency: pricing.currency };
  }
  const last = pricing.lastKnown;
  return last === null ? null : { amount: last.amount, currency: last.currency };
}

function release(store: CatalogueStore, sku: string): number {
  const restored = updateProduct(store, sku, (current) => ({
    ...current,
    stock: current.stock + 1,
  }));
  return restored?.stock ?? 0;
}
