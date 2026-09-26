import { describe, expect, it } from "vitest";
import { indexRemote, syncLink } from "../../src/catalogue/link-sync";
import { price, product } from "../fakes/catalogue-api";
import { link, merchantProduct, OBSERVED } from "../fakes/merchant";

const READ_AT = "2026-09-26T12:00:00.000Z";
const LATER = "2026-09-20T00:00:00.000Z";

function remoteWith(options: {
  products?: ReturnType<typeof product>[];
  prices?: ReturnType<typeof price>[];
}) {
  return indexRemote(
    options.products ?? [product({ id: "prod_1" })],
    options.prices ?? [price({ id: "price_1", productId: "prod_1" })],
  );
}

describe("syncLink", () => {
  it("leaves an unlinked product alone", () => {
    const local = merchantProduct({ sku: "TICKET" });

    expect(syncLink(local, remoteWith({}), READ_AT)).toEqual({
      outcome: "in_sync",
      product: local,
    });
  });

  it("reports a linked product that matches BuPayment as in sync", () => {
    const local = merchantProduct({ sku: "TICKET", bupayment: link() });

    expect(syncLink(local, remoteWith({}), READ_AT).outcome).toBe("in_sync");
  });

  it("pulls a changed amount into a stored price", () => {
    const local = merchantProduct({ sku: "TICKET", bupayment: link() });
    const remote = remoteWith({
      prices: [price({ id: "price_1", productId: "prod_1", unitAmount: 1800, updatedAt: LATER })],
    });

    const result = syncLink(local, remote, READ_AT);

    expect(result.outcome).toBe("updated");
    expect(result.product.pricing).toEqual({ mode: "stored", amount: 1800, currency: "EUR" });
    expect(result.product.bupayment?.priceUpdatedAt).toBe(LATER);
  });

  it("refreshes the last known live price without calling it a change", () => {
    const local = merchantProduct({
      sku: "TICKET",
      pricing: { mode: "live", lastKnown: { amount: 1500, currency: "EUR", readAt: OBSERVED } },
      bupayment: link(),
    });

    const result = syncLink(local, remoteWith({}), READ_AT);

    expect(result.outcome).toBe("in_sync");
    expect(result.product.pricing).toEqual({
      mode: "live",
      lastKnown: { amount: 1500, currency: "EUR", readAt: READ_AT },
    });
  });

  it("keeps the merchant's own fields", () => {
    const local = merchantProduct({
      sku: "TICKET",
      title: "Ferry ticket",
      imageUrl: "https://cdn.example.test/t.png",
      stock: 3,
      bupayment: link(),
    });
    const remote = remoteWith({
      products: [product({ id: "prod_1", name: "Other", updatedAt: LATER })],
    });

    expect(syncLink(local, remote, READ_AT).product).toMatchObject({
      title: "Ferry ticket",
      imageUrl: "https://cdn.example.test/t.png",
      stock: 3,
    });
  });

  it("marks an archived product unsellable and reports it once", () => {
    const local = merchantProduct({ sku: "TICKET", bupayment: link() });
    const remote = remoteWith({
      products: [product({ id: "prod_1", active: false, updatedAt: LATER })],
    });

    const first = syncLink(local, remote, READ_AT);
    const second = syncLink(first.product, remote, READ_AT);

    expect(first.outcome).toBe("archived");
    expect(first.product.bupayment?.sellable).toBe(false);
    expect(second.outcome).toBe("in_sync");
  });

  it("withdraws a product this application can no longer see", () => {
    const local = merchantProduct({ sku: "TICKET", bupayment: link() });

    const result = syncLink(local, indexRemote([], []), READ_AT);

    expect(result.outcome).toBe("withdrawn");
    expect(result.product.bupayment?.sellable).toBe(false);
  });

  it("makes a reactivated product sellable again", () => {
    const local = merchantProduct({ sku: "TICKET", bupayment: link({ sellable: false }) });
    const remote = remoteWith({ products: [product({ id: "prod_1", updatedAt: LATER })] });

    const result = syncLink(local, remote, READ_AT);

    expect(result.outcome).toBe("updated");
    expect(result.product.bupayment?.sellable).toBe(true);
  });

  it.each([
    ["product", { products: [product({ id: "prod_1", name: "Old" })] }],
    ["price", { prices: [price({ id: "price_1", productId: "prod_1", unitAmount: 1 })] }],
  ])("discards a %s read older than the one already applied", (_, remote) => {
    const local = merchantProduct({
      sku: "TICKET",
      bupayment: link({ productUpdatedAt: LATER, priceUpdatedAt: LATER }),
    });

    expect(syncLink(local, remoteWith(remote), READ_AT)).toEqual({
      outcome: "stale",
      product: local,
    });
  });

  it("discards a read whose updatedAt cannot be parsed", () => {
    const local = merchantProduct({ sku: "TICKET", bupayment: link() });
    const remote = remoteWith({ products: [product({ id: "prod_1", updatedAt: "garbled" })] });

    expect(syncLink(local, remote, READ_AT).outcome).toBe("stale");
  });

  it("repoints to the only compatible active price once the linked one is archived", () => {
    const local = merchantProduct({ sku: "TICKET", bupayment: link() });
    const remote = remoteWith({
      prices: [
        price({ id: "price_1", productId: "prod_1", active: false, updatedAt: LATER }),
        price({ id: "price_2", productId: "prod_1", unitAmount: 1800, updatedAt: LATER }),
        price({ id: "price_usd", productId: "prod_1", currency: "USD" }),
      ],
    });

    const result = syncLink(local, remote, READ_AT);

    expect(result.outcome).toBe("repointed");
    expect(result.product.bupayment?.priceId).toBe("price_2");
    expect(result.product.pricing).toEqual({ mode: "stored", amount: 1800, currency: "EUR" });
  });

  it.each([
    ["no", []],
    [
      "several",
      [
        price({ id: "price_2", productId: "prod_1" }),
        price({ id: "price_3", productId: "prod_1" }),
      ],
    ],
  ])("asks for a decision when %s compatible price replaces the archived one", (_, extra) => {
    const local = merchantProduct({ sku: "TICKET", bupayment: link() });
    const remote = remoteWith({
      prices: [
        price({ id: "price_1", productId: "prod_1", active: false, updatedAt: LATER }),
        ...extra,
      ],
    });

    const result = syncLink(local, remote, READ_AT);

    expect(result.outcome).toBe("price_needs_decision");
    expect(result.product.bupayment).toMatchObject({ priceId: "price_1", sellable: false });
    expect(result.product.pricing).toEqual(local.pricing);
  });

  it("asks for a decision instead of guessing when the linked price cannot be read", () => {
    const local = merchantProduct({ sku: "TICKET", bupayment: link() });
    const remote = remoteWith({
      prices: [price({ id: "price_usd", productId: "prod_1", currency: "USD" })],
    });

    const result = syncLink(local, remote, READ_AT);

    expect(result.outcome).toBe("price_needs_decision");
    expect(result.product.bupayment?.priceId).toBe("price_1");
  });

  it("does not treat a recurring price as a replacement for a one-time one", () => {
    const local = merchantProduct({ sku: "TICKET", bupayment: link() });
    const remote = remoteWith({
      prices: [
        price({ id: "price_1", productId: "prod_1", active: false, updatedAt: LATER }),
        price({
          id: "price_monthly",
          productId: "prod_1",
          type: "recurring",
          recurring: { interval: "month", intervalCount: 1 },
        }),
      ],
    });

    expect(syncLink(local, remote, READ_AT).outcome).toBe("price_needs_decision");
  });

  it("keeps the newest of two reads of the same resource", () => {
    const remote = indexRemote(
      [
        product({ id: "prod_1", name: "New", updatedAt: LATER }),
        product({ id: "prod_1", name: "Old" }),
      ],
      [],
    );

    expect(remote.products.get("prod_1")?.name).toBe("New");
  });
});
