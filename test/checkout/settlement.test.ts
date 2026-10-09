import type { CheckoutEvent } from "@bu-payment/node-sdk";
import { describe, expect, it } from "vitest";
import { emptyCatalogue, type MerchantCatalogue, putProduct } from "../../src/catalogue/merchant";
import { settleCheckout } from "../../src/checkout/settlement";
import { merchantProduct } from "../fakes/merchant";
import { checkoutEvent } from "../fakes/webhook";

function heldOrder(stock = 2): MerchantCatalogue {
  const catalogue = emptyCatalogue();
  putProduct(catalogue, merchantProduct({ sku: "TSHIRT", stock }));
  catalogue.reservations.A1 = "TSHIRT";
  catalogue.checkouts.chk_1 = { orderId: "A1", sku: "TSHIRT", settled: null };
  return catalogue;
}

function settleAll(catalogue: MerchantCatalogue, ...events: CheckoutEvent[]) {
  return events.map((event) => settleCheckout(catalogue, event));
}

describe("settleCheckout", () => {
  it("turns the held unit into a sale on checkout.completed", () => {
    const catalogue = heldOrder();

    expect(settleAll(catalogue, checkoutEvent("checkout.completed"))).toEqual(["sold"]);
    expect(catalogue.products.TSHIRT?.stock).toBe(2);
    expect(catalogue.reservations).toEqual({});
    expect(catalogue.checkouts.chk_1?.settled).toBe("sold");
  });

  it.each([
    "checkout.failed",
    "checkout.expired",
    "checkout.cancelled",
  ] as const)("gives the held unit back on %s", (type) => {
    const catalogue = heldOrder();

    expect(settleAll(catalogue, checkoutEvent(type))).toEqual(["released"]);
    expect(catalogue.products.TSHIRT?.stock).toBe(3);
    expect(catalogue.reservations).toEqual({});
    expect(catalogue.checkouts.chk_1?.settled).toBe("released");
  });

  it("settles each checkout once, whatever arrives after", () => {
    const catalogue = heldOrder();

    const outcomes = settleAll(
      catalogue,
      checkoutEvent("checkout.completed"),
      checkoutEvent("checkout.completed", { id: "evt_again" }),
      checkoutEvent("checkout.expired"),
    );

    expect(outcomes).toEqual(["sold", "already_settled", "already_settled"]);
    expect(catalogue.products.TSHIRT?.stock).toBe(2);
  });

  it("releases once when the release arrives twice", () => {
    const catalogue = heldOrder();

    settleAll(catalogue, checkoutEvent("checkout.expired"), checkoutEvent("checkout.cancelled"));

    expect(catalogue.products.TSHIRT?.stock).toBe(3);
  });

  it("still sells a unit when the checkout completes after it expired", () => {
    const catalogue = heldOrder();

    const outcomes = settleAll(
      catalogue,
      checkoutEvent("checkout.expired"),
      checkoutEvent("checkout.completed", { previousStatus: "expired" }),
    );

    expect(outcomes).toEqual(["released", "sold"]);
    expect(catalogue.products.TSHIRT?.stock).toBe(2);
    expect(catalogue.checkouts.chk_1?.settled).toBe("sold");
  });

  it("reports an oversale when a late completion finds no stock left", () => {
    const catalogue = heldOrder(0);
    catalogue.reservations = {};
    catalogue.checkouts.chk_1 = { orderId: "A1", sku: "TSHIRT", settled: "released" };

    expect(settleAll(catalogue, checkoutEvent("checkout.completed"))).toEqual(["oversold"]);
    expect(catalogue.products.TSHIRT?.stock).toBe(0);
    expect(catalogue.checkouts.chk_1?.settled).toBe("sold");
  });

  it("adopts an unrecorded checkout through the order its reference holds", () => {
    const catalogue = heldOrder();
    catalogue.checkouts = {};

    expect(settleAll(catalogue, checkoutEvent("checkout.completed"))).toEqual(["sold"]);
    expect(catalogue.checkouts.chk_1).toEqual({ orderId: "A1", sku: "TSHIRT", settled: "sold" });
  });

  it("leaves a checkout it cannot place untouched", () => {
    const catalogue = heldOrder();
    const before = structuredClone(catalogue);

    const outcomes = settleAll(
      catalogue,
      checkoutEvent("checkout.completed", { checkoutId: "chk_9", reference: "Z9" }),
      checkoutEvent("checkout.expired", { checkoutId: "chk_8", reference: null }),
    );

    expect(outcomes).toEqual(["unknown_checkout", "unknown_checkout"]);
    expect(catalogue).toEqual(before);
  });

  it("refuses a checkout whose reference names another order", () => {
    const catalogue = heldOrder();
    const before = structuredClone(catalogue);

    expect(settleAll(catalogue, checkoutEvent("checkout.completed", { reference: "B2" }))).toEqual([
      "reference_mismatch",
    ]);
    expect(catalogue).toEqual(before);
  });
});
