import { describe, expect, it } from "vitest";
import { emptyCatalogue, findProduct, isOlder, putProduct } from "../../src/catalogue/merchant";
import { merchantProduct } from "../fakes/merchant";

describe("findProduct and putProduct", () => {
  it("store and find a product by SKU", () => {
    const catalogue = emptyCatalogue();
    putProduct(catalogue, merchantProduct({ sku: "TICKET" }));

    expect(findProduct(catalogue, "TICKET")?.sku).toBe("TICKET");
    expect(findProduct(catalogue, "OTHER")).toBeUndefined();
  });

  it.each([
    "__proto__",
    "constructor",
    "toString",
  ])("treat %s as an ordinary SKU, never as an object key", (sku) => {
    const catalogue = emptyCatalogue();

    expect(findProduct(catalogue, sku)).toBeUndefined();
    putProduct(catalogue, merchantProduct({ sku }));

    expect(findProduct(catalogue, sku)?.sku).toBe(sku);
    expect(Object.getPrototypeOf(catalogue.products)).toBe(Object.prototype);
    expect(({} as { sku?: unknown }).sku).toBeUndefined();
  });
});

describe("isOlder", () => {
  it("compares instants rather than strings across offsets", () => {
    expect(isOlder("2026-09-01T23:30:00Z", "2026-09-02T01:00:00+02:00")).toBe(false);
    expect(isOlder("2026-09-01T22:30:00Z", "2026-09-02T01:00:00+02:00")).toBe(true);
  });

  it("treats an unparseable candidate as older", () => {
    expect(isOlder("garbled", "2026-09-01T00:00:00Z")).toBe(true);
  });

  it("does not treat an equal instant as older", () => {
    expect(isOlder("2026-09-01T00:00:00Z", "2026-09-01T00:00:00.000Z")).toBe(false);
  });
});
