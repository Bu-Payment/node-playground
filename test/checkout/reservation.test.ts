import { describe, expect, it } from "vitest";
import { emptyCatalogue, putProduct } from "../../src/catalogue/merchant";
import { memoryStore } from "../../src/catalogue/store";
import { orderReservation } from "../../src/checkout/reservation";
import { merchantProduct } from "../fakes/merchant";

function storeWith(stock: number) {
  const catalogue = emptyCatalogue();
  putProduct(catalogue, merchantProduct({ sku: "TSHIRT", stock }));
  return memoryStore(catalogue);
}

describe("orderReservation", () => {
  it("leaves the stock alone when the order holds nothing", () => {
    const store = storeWith(3);

    orderReservation(store, "A1", "TSHIRT").release();

    expect(store.load().products.TSHIRT?.stock).toBe(3);
    expect(store.load().reservations).toEqual({});
  });

  it("forgets the order of a product removed while it was held", () => {
    const store = storeWith(3);
    const reservation = orderReservation(store, "A1", "TSHIRT");
    reservation.reserve();
    const catalogue = store.load();
    delete catalogue.products.TSHIRT;
    store.save(catalogue);

    reservation.release();

    expect(store.load().reservations).toEqual({});
  });
});
