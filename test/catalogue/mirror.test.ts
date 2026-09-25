import { describe, expect, it } from "vitest";
import {
  applyPrice,
  applyProduct,
  emptyMirror,
  type MirroredProduct,
  setProductImage,
} from "../../src/catalogue/mirror";
import { price, product } from "../fakes/catalogue-api";

const EARLY = "2026-09-01T00:00:00.000Z";
const LATE = "2026-09-02T00:00:00.000Z";

describe("applyProduct", () => {
  it("creates a mirrored product with no local image", () => {
    const mirror = emptyMirror();

    const outcome = applyProduct(mirror, product({ id: "prod_1", name: "Ticket" }));

    expect(outcome).toBe("created");
    expect(mirror.products.prod_1).toEqual({
      bupaymentProductId: "prod_1",
      name: "Ticket",
      description: null,
      active: true,
      updatedAt: EARLY,
      imageUrl: null,
    });
  });

  it("reports the same resource applied twice as unchanged", () => {
    const mirror = emptyMirror();
    applyProduct(mirror, product({ id: "prod_1" }));

    expect(applyProduct(mirror, product({ id: "prod_1" }))).toBe("unchanged");
  });

  it("applies a newer version and keeps the local-only image", () => {
    const mirror = emptyMirror();
    applyProduct(mirror, product({ id: "prod_1", name: "Ticket" }));
    const stored = mirror.products.prod_1 as MirroredProduct;
    mirror.products.prod_1 = { ...stored, imageUrl: "https://cdn.test/t.png" };

    const outcome = applyProduct(mirror, product({ id: "prod_1", name: "Pass", updatedAt: LATE }));

    expect(outcome).toBe("updated");
    expect(mirror.products.prod_1).toMatchObject({
      name: "Pass",
      updatedAt: LATE,
      imageUrl: "https://cdn.test/t.png",
    });
  });

  it("discards a version older than the one already stored", () => {
    const mirror = emptyMirror();
    applyProduct(mirror, product({ id: "prod_1", name: "Pass", updatedAt: LATE }));

    const outcome = applyProduct(mirror, product({ id: "prod_1", name: "Ticket", active: false }));

    expect(outcome).toBe("stale");
    expect(mirror.products.prod_1).toMatchObject({ name: "Pass", active: true, updatedAt: LATE });
  });
});

describe("applyPrice", () => {
  it("caches the amount with the time it was observed", () => {
    const mirror = emptyMirror();

    const outcome = applyPrice(
      mirror,
      price({
        id: "price_1",
        productId: "prod_1",
        unitAmount: 900,
        type: "recurring",
        recurring: { interval: "month", intervalCount: 3 },
      }),
      LATE,
    );

    expect(outcome).toBe("created");
    expect(mirror.prices.price_1).toEqual({
      bupaymentPriceId: "price_1",
      bupaymentProductId: "prod_1",
      cachedUnitAmount: 900,
      cachedCurrency: "EUR",
      type: "recurring",
      interval: "month",
      intervalCount: 3,
      active: true,
      updatedAt: EARLY,
      syncedAt: LATE,
    });
  });

  it("refreshes the sync time of an unchanged price without calling it a change", () => {
    const mirror = emptyMirror();
    applyPrice(mirror, price({ id: "price_1", productId: "prod_1" }), EARLY);

    const outcome = applyPrice(mirror, price({ id: "price_1", productId: "prod_1" }), LATE);

    expect(outcome).toBe("unchanged");
    expect(mirror.prices.price_1?.syncedAt).toBe(LATE);
  });

  it("discards an older price and keeps its sync time", () => {
    const mirror = emptyMirror();
    applyPrice(mirror, price({ id: "price_1", productId: "prod_1", updatedAt: LATE }), EARLY);

    const outcome = applyPrice(
      mirror,
      price({ id: "price_1", productId: "prod_1", unitAmount: 1 }),
      LATE,
    );

    expect(outcome).toBe("stale");
    expect(mirror.prices.price_1).toMatchObject({ cachedUnitAmount: 1500, syncedAt: EARLY });
  });

  it("applies a changed amount carried by a newer version", () => {
    const mirror = emptyMirror();
    applyPrice(mirror, price({ id: "price_1", productId: "prod_1" }), EARLY);

    const outcome = applyPrice(
      mirror,
      price({ id: "price_1", productId: "prod_1", unitAmount: 1800, updatedAt: LATE }),
      LATE,
    );

    expect(outcome).toBe("updated");
    expect(mirror.prices.price_1?.cachedUnitAmount).toBe(1800);
  });
});

describe("setProductImage", () => {
  it("sets the local-only image of a mirrored product", () => {
    const mirror = emptyMirror();
    applyProduct(mirror, product({ id: "prod_1" }));

    expect(setProductImage(mirror, "prod_1", "https://cdn.test/t.png")).toBe(true);
    expect(mirror.products.prod_1?.imageUrl).toBe("https://cdn.test/t.png");
  });

  it("reports a product the mirror does not hold", () => {
    expect(setProductImage(emptyMirror(), "prod_unknown", null)).toBe(false);
  });
});
