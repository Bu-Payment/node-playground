import type { VerifiedWebhookDelivery } from "@bu-payment/node-sdk";
import { describe, expect, it } from "vitest";
import {
  emptyCatalogue,
  isSellable,
  type MerchantProduct,
  putProduct,
} from "../../src/catalogue/merchant";
import { memoryStore } from "../../src/catalogue/store";
import { receiveDelivery } from "../../src/catalogue/webhook";
import {
  type CatalogueApi,
  fakeCatalogueApi,
  price,
  product,
  unreachableApi,
} from "../fakes/catalogue-api";
import { link, merchantProduct } from "../fakes/merchant";
import { priceEvent, productEvent, verified } from "../fakes/webhook";
import { testContext } from "../fixtures";

const LATER = "2026-09-20T00:00:00.000Z";
const RECEIVED = new Date("2026-09-27T12:00:00.000Z");

function setup(products: MerchantProduct[], fetch: CatalogueApi["fetch"] = unreachableApi()) {
  const catalogue = emptyCatalogue();
  for (const entry of products) {
    putProduct(catalogue, entry);
  }
  const store = memoryStore(catalogue);
  const client = testContext({}, { fetch }).context.bupayment.catalogue;
  let saves = 0;
  const save = store.save.bind(store);
  store.save = (next) => {
    saves += 1;
    save(next);
  };
  return {
    store,
    saves: () => saves,
    receive: (delivery: VerifiedWebhookDelivery) =>
      receiveDelivery(client, store, delivery, () => RECEIVED),
  };
}

const LINKED = merchantProduct({ sku: "TICKET", bupayment: link() });
const ARCHIVED = productEvent(
  "catalogue.product.archived.v1",
  product({ id: "prod_1", active: false, updatedAt: LATER }),
);

describe("receiveDelivery", () => {
  it("applies an event and records the delivery and event ids in the same save", async () => {
    const { store, saves, receive } = setup([LINKED]);

    const report = await receive(verified(ARCHIVED, "dlv_1"));

    expect(report).toEqual({
      outcome: "applied",
      applied: ["TICKET"],
      stale: [],
      replacements: [],
    });
    expect(saves()).toBe(1);
    const saved = store.load();
    expect(isSellable(saved.products.TICKET?.bupayment ?? null)).toBe(false);
    expect(saved.received).toEqual({
      deliveries: { dlv_1: RECEIVED.toISOString() },
      events: { [ARCHIVED.id]: RECEIVED.toISOString() },
    });
  });

  it("treats a retried delivery as a duplicate and applies it once", async () => {
    const { store, receive } = setup([LINKED]);
    await receive(verified(ARCHIVED, "dlv_1"));
    const reactivated = productEvent(
      "catalogue.product.reactivated.v1",
      product({ id: "prod_1", updatedAt: "2026-09-21T00:00:00Z" }),
    );

    const report = await receive({ ...verified(reactivated, "dlv_1") });

    expect(report.outcome).toBe("duplicate");
    expect(store.load().products.TICKET?.bupayment?.productActive).toBe(false);
  });

  it("treats the same event through another endpoint as a duplicate", async () => {
    const { store, receive } = setup([LINKED]);
    await receive(verified(ARCHIVED, "dlv_1"));

    const report = await receive(verified(ARCHIVED, "dlv_2"));

    expect(report.outcome).toBe("duplicate");
    expect(Object.keys(store.load().received.deliveries)).toEqual(["dlv_1", "dlv_2"]);
  });

  it("ignores an event type this SDK does not know, and remembers it", async () => {
    const { store, receive } = setup([LINKED]);
    const unknown = {
      version: 1 as const,
      id: "evt_new",
      type: "unknown" as const,
      receivedType: "catalogue.product.renamed.v2",
      occurredAt: LATER,
      data: {},
    };

    const report = await receive({
      deliveryId: "dlv_1",
      signature: "unused",
      timestamp: RECEIVED,
      event: unknown,
    });

    expect(report.outcome).toBe("ignored");
    expect(store.load().received.events).toHaveProperty("evt_new");
    expect(store.load().products.TICKET).toEqual(LINKED);
  });

  it("reports an event older than the applied state as stale", async () => {
    const { receive } = setup([
      merchantProduct({ sku: "TICKET", bupayment: link({ productUpdatedAt: LATER }) }),
    ]);
    const old = productEvent(
      "catalogue.product.archived.v1",
      product({ id: "prod_1", active: false }),
    );

    expect((await receive(verified(old))).stale).toEqual(["TICKET"]);
  });

  it("replaces an archived linked price with the product's default price", async () => {
    const api = fakeCatalogueApi({
      products: [product({ id: "prod_1" })],
      prices: [
        price({ id: "price_1", productId: "prod_1", active: false, updatedAt: LATER }),
        price({ id: "price_2", productId: "prod_1" }),
        price({ id: "price_3", productId: "prod_1", unitAmount: 2000 }),
      ],
    });
    const { store, receive } = setup([LINKED], api.fetch);
    await receive(
      verified(
        priceEvent(
          "catalogue.price.archived.v1",
          price({ id: "price_1", productId: "prod_1", active: false, updatedAt: LATER }),
        ),
      ),
    );
    const defaultChanged = productEvent(
      "catalogue.product.default_price.updated.v1",
      product({ id: "prod_1" }),
      { id: "evt_default", occurredAt: LATER, defaultPriceId: "price_3" },
    );

    const report = await receive(verified(defaultChanged));

    expect(report.replacements).toEqual([{ sku: "TICKET", outcome: "repointed" }]);
    expect(store.load().products.TICKET).toMatchObject({
      pricing: { mode: "stored", amount: 2000 },
      bupayment: { priceId: "price_3", priceActive: true },
    });
  });

  it("replaces the price at once when there is a single compatible candidate", async () => {
    const api = fakeCatalogueApi({
      products: [product({ id: "prod_1" })],
      prices: [
        price({ id: "price_1", productId: "prod_1", active: false, updatedAt: LATER }),
        price({ id: "price_2", productId: "prod_1", unitAmount: 1700 }),
      ],
    });
    const { store, receive } = setup([LINKED], api.fetch);

    const report = await receive(
      verified(
        priceEvent(
          "catalogue.price.archived.v1",
          price({ id: "price_1", productId: "prod_1", active: false, updatedAt: LATER }),
        ),
      ),
    );

    expect(report.replacements).toEqual([{ sku: "TICKET", outcome: "repointed" }]);
    expect(isSellable(store.load().products.TICKET?.bupayment ?? null)).toBe(true);
  });

  it("keeps the product unsellable until the sweep when BuPayment cannot be read", async () => {
    const { store, receive } = setup([LINKED]);

    const report = await receive(
      verified(
        priceEvent(
          "catalogue.price.archived.v1",
          price({ id: "price_1", productId: "prod_1", active: false, updatedAt: LATER }),
        ),
      ),
    );

    expect(report.replacements).toEqual([{ sku: "TICKET", outcome: "unreachable" }]);
    expect(isSellable(store.load().products.TICKET?.bupayment ?? null)).toBe(false);
    expect(store.load().received.events).not.toEqual({});
  });

  it("replaces an unassigned linked price using the event's own copy of it", async () => {
    const api = fakeCatalogueApi({
      products: [product({ id: "prod_1" })],
      prices: [price({ id: "price_2", productId: "prod_1", unitAmount: 1700 })],
    });
    const { store, receive } = setup([LINKED], api.fetch);
    const unassigned = priceEvent(
      "catalogue.price.unassigned.v1",
      price({ id: "price_1", productId: "prod_1" }),
      {
        occurredAt: LATER,
      },
    );

    const report = await receive(verified(unassigned));

    expect(report.replacements).toEqual([{ sku: "TICKET", outcome: "repointed" }]);
    expect(store.load().products.TICKET?.bupayment).toMatchObject({
      priceId: "price_2",
      priceAssigned: true,
    });
  });

  it("treats a failing read of the linked price as unreachable, not as unassigned", async () => {
    const api = fakeCatalogueApi({
      products: [product({ id: "prod_1" })],
      prices: [price({ id: "price_2", productId: "prod_1" })],
    });
    const failing: CatalogueApi["fetch"] = async (input, init) =>
      new URL(input).pathname === "/v1/prices/price_1"
        ? Response.json({ error: "operation_failed" }, { status: 503 })
        : api.fetch(input, init);
    const { store, receive } = setup([LINKED], failing);

    const report = await receive(
      verified(
        priceEvent(
          "catalogue.price.archived.v1",
          price({ id: "price_1", productId: "prod_1", active: false, updatedAt: LATER }),
        ),
      ),
    );

    expect(report.replacements).toEqual([{ sku: "TICKET", outcome: "unreachable" }]);
    expect(store.load().products.TICKET?.bupayment).toMatchObject({
      priceAssigned: true,
      priceActive: false,
    });
  });

  it("drops a replacement read that a newer delivery overtook", async () => {
    const api = fakeCatalogueApi({
      products: [product({ id: "prod_1" })],
      prices: [
        price({ id: "price_1", productId: "prod_1", active: false, updatedAt: LATER }),
        price({ id: "price_2", productId: "prod_1" }),
      ],
    });
    let overtake: (() => Promise<unknown>) | undefined;
    const { store, receive } = setup([LINKED], async (input, init) => {
      const response = await api.fetch(input, init);
      const pending = overtake;
      overtake = undefined;
      await pending?.();
      return response;
    });
    overtake = () =>
      receive(
        verified(
          productEvent("catalogue.product.unassigned.v1", product({ id: "prod_1" }), {
            occurredAt: "2026-09-21T00:00:00Z",
          }),
        ),
      );

    const report = await receive(
      verified(
        priceEvent(
          "catalogue.price.archived.v1",
          price({ id: "price_1", productId: "prod_1", active: false, updatedAt: LATER }),
        ),
      ),
    );

    expect(report.replacements).toEqual([{ sku: "TICKET", outcome: "superseded" }]);
    expect(store.load().products.TICKET?.bupayment).toMatchObject({
      productAssigned: false,
      priceId: "price_1",
    });
    expect(isSellable(store.load().products.TICKET?.bupayment ?? null)).toBe(false);
  });
});
