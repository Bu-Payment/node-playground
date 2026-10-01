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

  it("never moves an order onto a second product", () => {
    const store = storeWith(3);
    const catalogue = store.load();
    putProduct(catalogue, merchantProduct({ sku: "MUG", stock: 3 }));
    store.save(catalogue);
    orderReservation(store, "A1", "TSHIRT").reserve();

    const taken = orderReservation(store, "A1", "MUG").reserve();

    expect(taken).toBe(false);
    expect(store.load().products.MUG?.stock).toBe(3);
    expect(store.load().reservations).toEqual({ A1: "TSHIRT" });
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
