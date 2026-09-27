import { describe, expect, it } from "vitest";
import { applyCatalogueEvent, defaultPriceIdOf } from "../../src/catalogue/events";
import { isSellable } from "../../src/catalogue/merchant";
import { price, product } from "../fakes/catalogue-api";
import { link, merchantProduct } from "../fakes/merchant";
import { priceEvent, productEvent } from "../fakes/webhook";

const LATER = "2026-09-20T00:00:00.000Z";
const RECEIVED = "2026-09-27T12:00:00.000Z";
const LINKED = merchantProduct({ sku: "TICKET", bupayment: link() });

describe("applyCatalogueEvent", () => {
  it("leaves an unlinked product alone", () => {
    const local = merchantProduct({ sku: "LOCAL" });

    const result = applyCatalogueEvent(
      local,
      productEvent(
        "catalogue.product.archived.v1",
        product({ id: "prod_1", active: false, updatedAt: LATER }),
      ),
      RECEIVED,
    );

    expect(result).toEqual({ outcome: "unrelated", product: local, needsReplacementPrice: false });
  });

  it("ignores an event about another product", () => {
    const event = productEvent(
      "catalogue.product.archived.v1",
      product({ id: "prod_other", active: false, updatedAt: LATER }),
    );

    expect(applyCatalogueEvent(LINKED, event, RECEIVED).outcome).toBe("unrelated");
  });

  it("marks the product unsellable when it is archived", () => {
    const event = productEvent(
      "catalogue.product.archived.v1",
      product({ id: "prod_1", active: false, updatedAt: LATER }),
    );

    const result = applyCatalogueEvent(LINKED, event, RECEIVED);

    expect(result.outcome).toBe("applied");
    expect(result.product.bupayment).toMatchObject({
      productActive: false,
      productUpdatedAt: LATER,
    });
    expect(isSellable(result.product.bupayment)).toBe(false);
  });

  it("discards a product event older than the state already applied", () => {
    const local = merchantProduct({ sku: "TICKET", bupayment: link({ productUpdatedAt: LATER }) });
    const event = productEvent(
      "catalogue.product.archived.v1",
      product({ id: "prod_1", active: false }),
    );

    expect(applyCatalogueEvent(local, event, RECEIVED)).toEqual({
      outcome: "stale",
      product: local,
      needsReplacementPrice: false,
    });
  });

  it("orders unassignment and assignment by occurredAt", () => {
    const resource = product({ id: "prod_1" });
    const unassigned = applyCatalogueEvent(
      LINKED,
      productEvent("catalogue.product.unassigned.v1", resource, {
        occurredAt: "2026-09-10T00:00:00Z",
      }),
      RECEIVED,
    );
    const lateAssignment = applyCatalogueEvent(
      unassigned.product,
      productEvent("catalogue.product.assigned.v1", resource, {
        occurredAt: "2026-09-05T00:00:00Z",
      }),
      RECEIVED,
    );

    expect(unassigned.product.bupayment).toMatchObject({
      productAssigned: false,
      productAssignmentAt: "2026-09-10T00:00:00Z",
    });
    expect(lateAssignment.outcome).toBe("stale");
    expect(isSellable(lateAssignment.product.bupayment)).toBe(false);
  });

  it("applies an assignment even when the resource itself did not change", () => {
    const local = merchantProduct({
      sku: "TICKET",
      bupayment: link({ productAssigned: false, productUpdatedAt: LATER }),
    });
    const event = productEvent("catalogue.product.assigned.v1", product({ id: "prod_1" }), {
      occurredAt: LATER,
    });

    const result = applyCatalogueEvent(local, event, RECEIVED);

    expect(result.outcome).toBe("applied");
    expect(result.product.bupayment).toMatchObject({
      productAssigned: true,
      productUpdatedAt: LATER,
    });
  });

  it("pulls a new amount into a stored price", () => {
    const event = priceEvent(
      "catalogue.price.updated.v1",
      price({ id: "price_1", productId: "prod_1", unitAmount: 1800, updatedAt: LATER }),
    );

    const result = applyCatalogueEvent(LINKED, event, RECEIVED);

    expect(result.product.pricing).toEqual({ mode: "stored", amount: 1800, currency: "EUR" });
    expect(result.product.bupayment?.priceUpdatedAt).toBe(LATER);
  });

  it("records a live price as the last known one", () => {
    const live = { ...LINKED, pricing: { mode: "live" as const, lastKnown: null } };
    const event = priceEvent(
      "catalogue.price.updated.v1",
      price({ id: "price_1", productId: "prod_1", unitAmount: 900, updatedAt: LATER }),
    );

    expect(applyCatalogueEvent(live, event, RECEIVED).product.pricing).toEqual({
      mode: "live",
      lastKnown: { amount: 900, currency: "EUR", readAt: RECEIVED },
    });
  });

  it("discards a price event older than the state already applied", () => {
    const local = merchantProduct({ sku: "TICKET", bupayment: link({ priceUpdatedAt: LATER }) });
    const event = priceEvent(
      "catalogue.price.updated.v1",
      price({ id: "price_1", productId: "prod_1", unitAmount: 1 }),
    );

    expect(applyCatalogueEvent(local, event, RECEIVED).outcome).toBe("stale");
  });

  it("asks for a replacement when the linked price is archived", () => {
    const event = priceEvent(
      "catalogue.price.archived.v1",
      price({ id: "price_1", productId: "prod_1", active: false, updatedAt: LATER }),
    );

    const result = applyCatalogueEvent(LINKED, event, RECEIVED);

    expect(result.needsReplacementPrice).toBe(true);
    expect(isSellable(result.product.bupayment)).toBe(false);
  });

  it("asks for a replacement when the linked price is unassigned", () => {
    const event = priceEvent(
      "catalogue.price.unassigned.v1",
      price({ id: "price_1", productId: "prod_1" }),
      { occurredAt: LATER },
    );

    const result = applyCatalogueEvent(LINKED, event, RECEIVED);

    expect(result.product.bupayment).toMatchObject({
      priceAssigned: false,
      priceAssignmentAt: LATER,
    });
    expect(result.needsReplacementPrice).toBe(true);
  });

  it("discards a price assignment older than the last one applied", () => {
    const local = merchantProduct({
      sku: "TICKET",
      bupayment: link({ priceAssigned: false, priceAssignmentAt: LATER }),
    });
    const event = priceEvent(
      "catalogue.price.assigned.v1",
      price({ id: "price_1", productId: "prod_1" }),
      {
        occurredAt: "2026-09-10T00:00:00Z",
      },
    );

    expect(applyCatalogueEvent(local, event, RECEIVED).outcome).toBe("stale");
  });

  it("applies a price assignment even when the price itself did not change", () => {
    const local = merchantProduct({
      sku: "TICKET",
      bupayment: link({ priceAssigned: false, priceUpdatedAt: LATER }),
    });
    const event = priceEvent(
      "catalogue.price.assigned.v1",
      price({ id: "price_1", productId: "prod_1" }),
      {
        occurredAt: LATER,
      },
    );

    const result = applyCatalogueEvent(local, event, RECEIVED);

    expect(result.product.bupayment).toMatchObject({ priceAssigned: true, priceUpdatedAt: LATER });
    expect(result.product.pricing).toEqual(local.pricing);
  });

  it("asks for a replacement when a new price appears for a product waiting for one", () => {
    const waiting = merchantProduct({ sku: "TICKET", bupayment: link({ priceActive: false }) });
    const event = priceEvent(
      "catalogue.price.created.v1",
      price({ id: "price_2", productId: "prod_1", updatedAt: LATER }),
    );

    const result = applyCatalogueEvent(waiting, event, RECEIVED);

    expect(result).toMatchObject({ outcome: "unrelated", needsReplacementPrice: true });
  });

  it.each([
    ["of another product", price({ id: "price_2", productId: "prod_other", updatedAt: LATER })],
    [
      "that is archived",
      price({ id: "price_2", productId: "prod_1", active: false, updatedAt: LATER }),
    ],
  ])("does not ask for a replacement for a new price %s", (_, resource) => {
    const waiting = merchantProduct({ sku: "TICKET", bupayment: link({ priceActive: false }) });

    const result = applyCatalogueEvent(
      waiting,
      priceEvent("catalogue.price.created.v1", resource),
      RECEIVED,
    );

    expect(result.needsReplacementPrice).toBe(false);
  });

  it("does not ask for a replacement for an unassigned product", () => {
    const unassigned = merchantProduct({
      sku: "TICKET",
      bupayment: link({ productAssigned: false }),
    });
    const event = priceEvent(
      "catalogue.price.archived.v1",
      price({ id: "price_1", productId: "prod_1", active: false, updatedAt: LATER }),
    );

    expect(applyCatalogueEvent(unassigned, event, RECEIVED).needsReplacementPrice).toBe(false);
  });

  it("does not ask for a replacement while the linked price is still usable", () => {
    const event = priceEvent(
      "catalogue.price.created.v1",
      price({ id: "price_2", productId: "prod_1", updatedAt: LATER }),
    );

    expect(applyCatalogueEvent(LINKED, event, RECEIVED).needsReplacementPrice).toBe(false);
  });

  it("does not ask for a replacement for an archived product", () => {
    const archived = merchantProduct({ sku: "TICKET", bupayment: link({ productActive: false }) });
    const event = priceEvent(
      "catalogue.price.archived.v1",
      price({ id: "price_1", productId: "prod_1", active: false, updatedAt: LATER }),
    );

    expect(applyCatalogueEvent(archived, event, RECEIVED).needsReplacementPrice).toBe(false);
  });
});

describe("defaultPriceIdOf", () => {
  it("reads the default price of a product event and nothing from a price event", () => {
    expect(
      defaultPriceIdOf(
        productEvent("catalogue.product.default_price.updated.v1", product({ id: "prod_1" }), {
          defaultPriceId: "price_9",
        }),
      ),
    ).toBe("price_9");
    expect(
      defaultPriceIdOf(
        priceEvent("catalogue.price.created.v1", price({ id: "price_1", productId: "prod_1" })),
      ),
    ).toBeNull();
  });
});
