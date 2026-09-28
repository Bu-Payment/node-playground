import type { RequestHandler } from "express";
import { z } from "zod";
import { type SaleRefusal, sell } from "../../checkout/sale";
import type { AppContext } from "../../runtime/context";

const OrderBody = z
  .object({
    sku: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
    email: z.email().max(320),
  })
  .strict();

export function checkoutRoute(context: AppContext): RequestHandler {
  return async (request, response) => {
    const body = OrderBody.safeParse(request.body);
    if (!body.success) {
      response
        .status(422)
        .json({ code: "checkout_invalid", message: "The order needs a sku and an email." });
      return;
    }
    const result = await sell(context.bupayment, context.catalogue, body.data);
    if (result.sold) {
      const { id, status, amount, currency } = result.payment;
      response.status(201).json({ payment: { id, status, amount, currency }, stock: result.stock });
      return;
    }
    if (result.reason === "price_changed") {
      response.status(409).json({
        code: "price_changed",
        message: "The price changed since it was shown. Reload the catalogue and try again.",
        shown: result.shown,
        current: result.current,
      });
      return;
    }
    response
      .status(result.reason === "product_not_found" ? 404 : 409)
      .json({ code: result.reason, message: SALE_REFUSALS[result.reason] });
  };
}

const SALE_REFUSALS: Record<SaleRefusal, string> = {
  product_not_found: "No such local product.",
  not_sellable: "The product is not linked to an active BuPayment price.",
  price_unknown: "No price has been shown for this product yet. Load the catalogue first.",
  out_of_stock: "The product is out of stock.",
};
