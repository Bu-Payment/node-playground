import type { RequestHandler } from "express";
import { z } from "zod";
import { setProductImage } from "../../catalogue/mirror";
import { storefront } from "../../catalogue/storefront";
import type { AppContext } from "../../runtime/context";

const ImageBody = z.object({
  imageUrl: z.url({ protocol: /^https?$/ }).nullable(),
});

export function catalogueRoute(context: AppContext): RequestHandler {
  return (_request, response) => {
    response.json({ products: storefront(context.catalogue.load()) });
  };
}

export function productImageRoute(context: AppContext): RequestHandler<{ productId: string }> {
  return (request, response) => {
    const body = ImageBody.safeParse(request.body);
    if (!body.success) {
      response
        .status(422)
        .json({ code: "image_url_invalid", message: "imageUrl must be an http(s) URL or null." });
      return;
    }
    const mirror = context.catalogue.load();
    if (!setProductImage(mirror, request.params.productId, body.data.imageUrl)) {
      response
        .status(404)
        .json({ code: "product_not_mirrored", message: "No such product in the local mirror." });
      return;
    }
    context.catalogue.save(mirror);
    response.status(204).end();
  };
}
