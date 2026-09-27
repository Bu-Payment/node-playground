import type { RequestHandler } from "express";
import { z } from "zod";
import { linkProduct } from "../../catalogue/linking";
import {
  findProduct,
  type MerchantProduct,
  MoneySchema,
  PRICING_MODES,
  putProduct,
} from "../../catalogue/merchant";
import { changePrice, type OrphanedPrice } from "../../catalogue/price-change";
import { buildStorefront, rememberLivePrices } from "../../catalogue/storefront";
import type { AppContext } from "../../runtime/context";
import { describeFailure } from "../../runtime/errors";

const NewProductBody = z.object({
  sku: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  title: z.string().trim().min(1).max(200),
  slug: z.string().regex(/^[a-z0-9-]{1,100}$/),
  imageUrl: z
    .url({ protocol: /^https?$/ })
    .nullable()
    .default(null),
  stock: z.number().int().nonnegative(),
  price: MoneySchema,
});

const PriceBody = z.object({ amount: MoneySchema.shape.amount }).strict();

const LinkBody = z.object({
  productId: z.string().min(1),
  priceId: z.string().min(1),
  pricing: z.enum(PRICING_MODES),
});

export function catalogueRoute(context: AppContext): RequestHandler {
  return async (_request, response) => {
    const catalogue = context.catalogue.load();
    const storefront = await buildStorefront(catalogue, (priceId) =>
      context.bupayment.catalogue.price(priceId).get(),
    );
    rememberLivePrices(context.catalogue, storefront.reads, new Date().toISOString());
    response.json({ products: storefront.products });
  };
}

export function createProductRoute(context: AppContext): RequestHandler {
  return (request, response) => {
    const body = NewProductBody.safeParse(request.body);
    if (!body.success) {
      response.status(422).json({ code: "product_invalid", message: "The product is not valid." });
      return;
    }
    const catalogue = context.catalogue.load();
    if (findProduct(catalogue, body.data.sku) !== undefined) {
      response.status(409).json({ code: "product_exists", message: "That SKU already exists." });
      return;
    }
    const { price, ...fields } = body.data;
    const product: MerchantProduct = {
      ...fields,
      pricing: { mode: "stored", ...price },
      bupayment: null,
    };
    putProduct(catalogue, product);
    context.catalogue.save(catalogue);
    response.status(201).json(product);
  };
}

export function linkProductRoute(context: AppContext): RequestHandler<{ sku: string }> {
  return async (request, response) => {
    const body = LinkBody.safeParse(request.body);
    if (!body.success) {
      response
        .status(422)
        .json({ code: "link_invalid", message: "The link request is not valid." });
      return;
    }
    const result = await linkProduct(
      context.bupayment.catalogue,
      context.catalogue,
      request.params.sku,
      body.data,
    );
    if (result.linked) {
      response.json(result.product);
      return;
    }
    if (result.reason === "product_not_found") {
      response.status(404).json({ code: "product_not_found", message: "No such local product." });
      return;
    }
    response.status(422).json({ code: result.reason, message: LINK_REFUSALS[result.reason] });
  };
}

export function changePriceRoute(context: AppContext): RequestHandler<{ sku: string }> {
  return async (request, response) => {
    const body = PriceBody.safeParse(request.body);
    if (!body.success) {
      response
        .status(422)
        .json({ code: "price_invalid", message: "amount must be a non-negative integer." });
      return;
    }
    const sku = request.params.sku;
    const result = await changePrice(
      context.bupayment.catalogue,
      context.catalogue,
      sku,
      body.data.amount,
    );
    if (!result.changed) {
      if (result.reason === "product_changed" && result.orphan !== null) {
        logOrphan(context, sku, result.orphan);
      }
      response.status(result.reason === "product_not_found" ? 404 : 409).json({
        code: result.reason,
        message: PRICE_REFUSALS[result.reason],
      });
      return;
    }
    const pending = result.archivePending;
    if (pending !== null) {
      context.logger.error("Previous BuPayment price was not archived", {
        sku,
        previousPriceId: pending.previousPriceId,
        outcome: pending.outcome,
        code: describeFailure(pending.error).code,
      });
    }
    response.json({ product: result.product, archivePending: pending !== null });
  };
}

function logOrphan(context: AppContext, sku: string, orphan: OrphanedPrice): void {
  if (orphan.archived) {
    context.logger.info("Unused BuPayment price archived", { sku, priceId: orphan.priceId });
    return;
  }
  context.logger.error("Unused BuPayment price left active", {
    sku,
    priceId: orphan.priceId,
    code: describeFailure(orphan.error).code,
  });
}

const PRICE_REFUSALS = {
  product_not_found: "No such local product.",
  product_changed: "The product changed while its price was being changed; nothing was applied.",
} as const;

const LINK_REFUSALS = {
  price_not_of_product: "The price does not belong to that BuPayment product.",
  inactive: "The BuPayment product or price is archived.",
} as const;
