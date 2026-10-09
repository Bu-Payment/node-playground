import type { SaleReservation } from "@bu-payment/node-sdk";
import {
  defineOwnKey,
  findProduct,
  type MerchantCatalogue,
  putProduct,
} from "../catalogue/merchant";
import type { CatalogueStore } from "../catalogue/store";

export function heldBy(catalogue: MerchantCatalogue, orderId: string): string | undefined {
  return Object.hasOwn(catalogue.reservations, orderId)
    ? catalogue.reservations[orderId]
    : undefined;
}

export function returnHeldUnit(
  catalogue: MerchantCatalogue,
  orderId: string,
  sku: string,
): boolean {
  if (!keepHeldUnit(catalogue, orderId, sku)) {
    return false;
  }
  const product = findProduct(catalogue, sku);
  if (product !== undefined) {
    putProduct(catalogue, { ...product, stock: product.stock + 1 });
  }
  return true;
}

export function keepHeldUnit(catalogue: MerchantCatalogue, orderId: string, sku: string): boolean {
  if (heldBy(catalogue, orderId) !== sku) {
    return false;
  }
  delete catalogue.reservations[orderId];
  return true;
}

export function deferredRelease(reservation: SaleReservation) {
  let releaseRequested = false;
  return {
    reservation: {
      reserve: reservation.reserve,
      release: () => {
        releaseRequested = true;
      },
    } satisfies SaleReservation,
    flush: async () => {
      if (releaseRequested) {
        releaseRequested = false;
        await reservation.release();
      }
    },
  };
}

export function orderReservation(
  store: CatalogueStore,
  orderId: string,
  sku: string,
): SaleReservation {
  return {
    reserve: () => {
      const catalogue = store.load();
      const held = heldBy(catalogue, orderId);
      if (held !== undefined) {
        return held === sku;
      }
      const product = findProduct(catalogue, sku);
      if (product === undefined || product.stock === 0) {
        return false;
      }
      putProduct(catalogue, { ...product, stock: product.stock - 1 });
      defineOwnKey(catalogue.reservations, orderId, sku);
      store.save(catalogue);
      return true;
    },
    release: () => {
      const catalogue = store.load();
      if (returnHeldUnit(catalogue, orderId, sku)) {
        store.save(catalogue);
      }
    },
  };
}
