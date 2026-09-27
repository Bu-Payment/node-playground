import { describe, expect, it } from "vitest";
import { rememberLivePrice } from "../../src/catalogue/storefront";
import { price } from "../fakes/catalogue-api";
import { link, merchantProduct } from "../fakes/merchant";

const READ_AT = "2026-09-26T12:00:00.000Z";
const LIVE = merchantProduct({
  sku: "PASS",
  pricing: { mode: "live", lastKnown: null },
  bupayment: link(),
});

describe("rememberLivePrice", () => {
  it("records the price just read as the last known one", () => {
    const read = {
      sku: "PASS",
      price: price({ id: "price_1", productId: "prod_1", unitAmount: 900 }),
    };

    expect(rememberLivePrice(LIVE, read, READ_AT)?.pricing).toEqual({
      mode: "live",
      lastKnown: { amount: 900, currency: "EUR", readAt: READ_AT },
    });
  });

  it("declines when the product was relinked to another price meanwhile", () => {
    const read = { sku: "PASS", price: price({ id: "price_old", productId: "prod_1" }) };

    expect(rememberLivePrice(LIVE, read, READ_AT)).toBeUndefined();
  });

  it("declines when the product switched to a stored price meanwhile", () => {
    const stored = { ...LIVE, pricing: { mode: "stored" as const, amount: 1, currency: "EUR" } };
    const read = { sku: "PASS", price: price({ id: "price_1", productId: "prod_1" }) };

    expect(rememberLivePrice(stored, read, READ_AT)).toBeUndefined();
  });
});
