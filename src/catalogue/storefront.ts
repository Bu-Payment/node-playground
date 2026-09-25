import type { PriceInterval } from "@bu-payment/node-sdk";
import type { CatalogueMirror, MirroredPrice } from "./mirror";

export interface StorefrontPrice {
  id: string;
  type: "one_time" | "recurring";
  interval: PriceInterval | null;
  intervalCount: number | null;
  display: { unitAmount: number; currency: string; syncedAt: string };
}

export interface StorefrontProduct {
  id: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  prices: StorefrontPrice[];
}

export function storefront(mirror: CatalogueMirror): StorefrontProduct[] {
  const prices = Object.values(mirror.prices).filter((price) => price.active);
  return Object.values(mirror.products)
    .filter((product) => product.active)
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((product) => ({
      id: product.bupaymentProductId,
      name: product.name,
      description: product.description,
      imageUrl: product.imageUrl,
      prices: prices
        .filter((price) => price.bupaymentProductId === product.bupaymentProductId)
        .map(displayPrice),
    }));
}

function displayPrice(price: MirroredPrice): StorefrontPrice {
  return {
    id: price.bupaymentPriceId,
    type: price.type,
    interval: price.interval,
    intervalCount: price.intervalCount,
    display: {
      unitAmount: price.cachedUnitAmount,
      currency: price.cachedCurrency,
      syncedAt: price.syncedAt,
    },
  };
}
