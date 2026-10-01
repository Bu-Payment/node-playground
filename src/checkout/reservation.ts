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

export function orderReservation(
  store: CatalogueStore,
  orderId: string,
  sku: string,
): SaleReservation {
  return {
    reserve: () => {
      const catalogue = store.load();
      if (heldBy(catalogue, orderId) === sku) {
        return true;
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
      if (heldBy(catalogue, orderId) !== sku) {
        return;
      }
      delete catalogue.reservations[orderId];
      const product = findProduct(catalogue, sku);
      if (product !== undefined) {
        putProduct(catalogue, { ...product, stock: product.stock + 1 });
      }
      store.save(catalogue);
    },
  };
}
