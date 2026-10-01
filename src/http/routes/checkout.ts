import type { Payment } from "@bu-payment/node-sdk";
import type { RequestHandler, Response } from "express";
import { z } from "zod";
import { findProduct } from "../../catalogue/merchant";
import { type CheckoutRefusal, type CheckoutResult, type Order, sell } from "../../checkout/sale";
import type { AppContext } from "../../runtime/context";

const OrderBody = z
  .object({
    orderId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    sku: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
    email: z.email().max(320),
  })
  .strict();

export function checkoutRoute(context: AppContext): RequestHandler {
  return async (request, response) => {
    const body = OrderBody.safeParse(request.body);
    if (!body.success) {
      response.status(422).json({
        code: "checkout_invalid",
        message: "The order needs an orderId, a sku and an email.",
      });
      return;
    }
    const result = await sell(context.bupayment, context.catalogue, body.data);
    answer(context, response, body.data, result);
  };
}

function answer(context: AppContext, response: Response, order: Order, result: CheckoutResult) {
  const orderId = order.orderId;
  switch (result.outcome) {
    case "paid":
    case "unpaid":
      response.status(result.outcome === "paid" ? 201 : 202).json({
        orderId,
        payment: paymentView(result.payment),
        stock: findProduct(context.catalogue.load(), order.sku)?.stock ?? 0,
      });
      return;
    case "price_changed":
      response.status(409).json({
        code: "price_changed",
        message: "The price changed since it was shown. Reload the catalogue and try again.",
        shown: { amount: result.shown.unitAmount, currency: result.shown.currency },
        current:
          result.current === null
            ? null
            : { amount: result.current.unitAmount, currency: result.current.currency },
      });
      return;
    case "unconfirmed":
      context.logger.info("Payment unconfirmed", {
        orderId,
        sku: order.sku,
        code: result.error.code,
      });
      response.status(202).json({
        orderId,
        status: "confirming",
        message: "The payment is not confirmed yet. Retry with the same orderId.",
      });
      return;
    case "needs_reconciliation":
      context.logger.error("Payment needs reconciliation", {
        orderId,
        sku: order.sku,
        code: result.error.code,
        ...(result.error.requestId === undefined ? {} : { requestId: result.error.requestId }),
      });
      response.status(202).json({
        orderId,
        status: "under_review",
        message: "The payment needs to be checked before this order can go on.",
      });
      return;
    case "unavailable":
      refuse(response, "out_of_stock");
      return;
    case "refused":
      refuse(response, result.reason);
      return;
  }
}

function paymentView({ id, status, amount, currency }: Payment) {
  return { id, status, amount, currency };
}

function refuse(response: Response, reason: CheckoutRefusal | "out_of_stock") {
  response
    .status(reason === "product_not_found" ? 404 : 409)
    .json({ code: reason, message: CHECKOUT_REFUSALS[reason] });
}

const CHECKOUT_REFUSALS: Record<CheckoutRefusal | "out_of_stock", string> = {
  product_not_found: "No such local product.",
  not_sellable: "The product is not linked to an active BuPayment price.",
  price_unknown: "No price has been shown for this product yet. Load the catalogue first.",
  order_mismatch: "That orderId already belongs to another product.",
  out_of_stock: "The product is out of stock.",
};
