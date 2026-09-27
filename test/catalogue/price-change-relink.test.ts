import { describe, expect, it } from "vitest";
import { putProduct } from "../../src/catalogue/merchant";
import { link, merchantProduct } from "../fakes/merchant";
import { LINKED, setupPriceChange, twoPriceApi } from "../fakes/price-change";

describe("changePrice while the product is relinked", () => {
  it.each([
    ["a linked", LINKED, link({ priceId: "price_other" })],
    ["an unlinked", merchantProduct({ sku: "TICKET" }), link()],
  ])("refuses to overwrite %s product relinked while its price was changing", async (_, local, relinked) => {
    const { store, change } = setupPriceChange(local);
    const load = store.load.bind(store);
    let loads = 0;
    store.load = () => {
      loads += 1;
      const catalogue = load();
      if (loads > 1) {
        putProduct(catalogue, { ...local, bupayment: relinked });
      }
      return catalogue;
    };

    const result = await change("TICKET", 1800);

    expect(result).toMatchObject({ changed: false, reason: "product_changed" });
  });

  it("archives the price it created when the product was relinked meanwhile", async () => {
    const { api, store, change } = setupPriceChange(LINKED);
    const load = store.load.bind(store);
    let loads = 0;
    store.load = () => {
      loads += 1;
      const catalogue = load();
      if (loads > 1) {
        putProduct(catalogue, { ...LINKED, bupayment: link({ priceId: "price_other" }) });
      }
      return catalogue;
    };

    const result = await change("TICKET", 1800);

    expect(result).toEqual({
      changed: false,
      reason: "product_changed",
      orphan: { priceId: "price_new_3", archived: true, error: null },
    });
    expect(api.prices.find((row) => row.id === "price_new_3")?.active).toBe(false);
  });

  it("reports an unused price it could not archive", async () => {
    const api = twoPriceApi();
    const { store, change } = setupPriceChange(LINKED, api);
    const load = store.load.bind(store);
    let loads = 0;
    store.load = () => {
      loads += 1;
      const catalogue = load();
      if (loads > 1) {
        api.failArchive = true;
        putProduct(catalogue, { ...LINKED, bupayment: link({ priceId: "price_other" }) });
      }
      return catalogue;
    };

    const result = await change("TICKET", 1800);

    expect(result).toMatchObject({
      reason: "product_changed",
      orphan: { priceId: "price_new_3", archived: false },
    });
  });

  it("keeps the change when a webhook already moved the link to the new price", async () => {
    const { api, store, change } = setupPriceChange(LINKED);
    const load = store.load.bind(store);
    let loads = 0;
    store.load = () => {
      loads += 1;
      const catalogue = load();
      if (loads > 1) {
        putProduct(catalogue, { ...LINKED, bupayment: link({ priceId: "price_new_3" }) });
      }
      return catalogue;
    };

    const result = await change("TICKET", 1800);

    expect(result.changed).toBe(true);
    expect(api.prices.find((row) => row.id === "price_new_3")?.active).toBe(true);
  });
});
