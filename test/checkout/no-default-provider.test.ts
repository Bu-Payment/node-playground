import { describe, expect, it } from "vitest";
import { emptyCatalogue, putProduct } from "../../src/catalogue/merchant";
import { memoryStore } from "../../src/catalogue/store";
import type { HostedCheckoutSettings } from "../../src/checkout/hosted";
import { sell } from "../../src/checkout/sale";
import { CHECKOUT_URL, fakeHostedCheckoutApi, withoutDefaultProvider } from "../fakes/checkout-api";
import { link, merchantProduct } from "../fakes/merchant";
import { testContext } from "../fixtures";

const TSHIRT = merchantProduct({
  sku: "TSHIRT",
  stock: 3,
  pricing: { mode: "stored", amount: 2750, currency: "EUR" },
  bupayment: link(),
});

const TMT: HostedCheckoutSettings = { destination: "tours", provider: "trust-my-travel" };

function setup(settings: HostedCheckoutSettings | null) {
  const api = withoutDefaultProvider(fakeHostedCheckoutApi());
  const catalogue = emptyCatalogue();
  putProduct(catalogue, TSHIRT);
  const store = memoryStore(catalogue);
  const client = testContext({}, { fetch: api.fetch }).context.bupayment;
  return {
    api,
    store,
    stock: () => store.load().products.TSHIRT?.stock,
    sell: () =>
      sell(client, store, { orderId: "A1", sku: "TSHIRT", email: "b@example.test" }, settings),
  };
}

describe("sell on an environment without a default provider", () => {
  it("opens the hosted checkout with the configured provider and holds the unit", async () => {
    const { api, store, stock, sell: sale } = setup(TMT);

    const result = await sale();

    expect(result).toMatchObject({
      outcome: "checkout_open",
      checkout: { id: "chk_1", checkoutUrl: CHECKOUT_URL, provider: "trust-my-travel" },
    });
    expect(api.directCharges).toBe(1);
    expect(api.requests[0]?.body).toMatchObject({ provider: "trust-my-travel" });
    expect(stock()).toBe(2);
    expect(store.load().reservations).toEqual({ A1: "TSHIRT" });
  });

  it("goes straight back to the checkout when the order retries", async () => {
    const { api, stock, sell: sale } = setup(TMT);

    await sale();
    const retried = await sale();

    expect(retried).toMatchObject({ outcome: "checkout_open", checkout: { id: "chk_1" } });
    expect(api.directCharges).toBe(1);
    expect(stock()).toBe(2);
  });

  it("releases the unit when the checkout refuses after the fallback", async () => {
    const { api, stock, store, sell: sale } = setup(TMT);
    api.failure = Response.json(
      { error: "checkout_live_not_enabled", message: "Live is not enabled" },
      { status: 409 },
    );

    expect(await sale()).toMatchObject({ outcome: "checkout_refused" });
    expect(stock()).toBe(3);
    expect(store.load().reservations).toEqual({});
  });

  it.each([
    ["no checkout provider is configured", { destination: "tours", provider: null }],
    ["no checkout is configured", null],
  ])("refuses and releases the unit when %s", async (_, settings) => {
    const { api, stock, store, sell: sale } = setup(settings);

    expect(await sale()).toEqual({ outcome: "refused", reason: "default_provider_not_configured" });
    expect(api.requests).toEqual([]);
    expect(stock()).toBe(3);
    expect(store.load().reservations).toEqual({});
  });
});
