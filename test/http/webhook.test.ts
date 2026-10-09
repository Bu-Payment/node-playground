import { describe, expect, it } from "vitest";
import { emptyCatalogue, isSellable, putProduct } from "../../src/catalogue/merchant";
import { memoryStore } from "../../src/catalogue/store";
import { createApp } from "../../src/http/app";
import { product } from "../fakes/catalogue-api";
import { link, merchantProduct } from "../fakes/merchant";
import { checkoutEvent, productEvent, signed, WEBHOOK_SECRET } from "../fakes/webhook";
import { testContext } from "../fixtures";
import { serve } from "../serve";

const LATER = "2026-09-20T00:00:00.000Z";
const ARCHIVED = productEvent(
  "catalogue.product.archived.v1",
  product({ id: "prod_1", active: false, updatedAt: LATER }),
);

async function webhookApp(secret: string | null = WEBHOOK_SECRET) {
  const catalogue = emptyCatalogue();
  putProduct(catalogue, merchantProduct({ sku: "TICKET", bupayment: link() }));
  const store = memoryStore(catalogue);
  const { context, lines } = testContext(
    secret === null ? {} : { BUPAYMENT_WEBHOOK_SECRET: secret },
  );
  return { app: await serve(createApp({ ...context, catalogue: store })), store, lines };
}

function post(
  app: Awaited<ReturnType<typeof webhookApp>>["app"],
  delivery: ReturnType<typeof signed>,
) {
  return app.post("/webhooks/bupayment").set(delivery.headers).send(delivery.body);
}

describe("POST /webhooks/bupayment", () => {
  it("applies a signed delivery", async () => {
    const { app, store, lines } = await webhookApp();

    const response = await post(app, signed(ARCHIVED));

    expect(response.status).toBe(200);
    expect(response.body.outcome).toBe("applied");
    expect(isSellable(store.load().products.TICKET?.bupayment ?? null)).toBe(false);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      message: "Webhook delivery received",
      eventId: ARCHIVED.id,
      type: "catalogue.product.archived.v1",
      outcome: "applied",
    });
  });

  it("verifies the exact bytes received, not a re-serialized body", async () => {
    const { app } = await webhookApp();
    const spaced = JSON.stringify(ARCHIVED, null, 2).replace("prod_1", "prod\\u005f1");

    const response = await post(app, signed(ARCHIVED, { body: spaced }));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true, outcome: "applied" });
  });

  it("refuses a tampered delivery and changes nothing", async () => {
    const { app, store } = await webhookApp();
    const delivery = signed(ARCHIVED);
    const before = store.load();

    const response = await post(app, {
      ...delivery,
      body: delivery.body.replace('"active":false', '"active":true'),
    });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("webhook_signature_invalid");
    expect(store.load()).toEqual(before);
  });

  it("logs a refused delivery by its code only", async () => {
    const { app, lines } = await webhookApp();
    const delivery = signed(ARCHIVED);

    await post(app, { ...delivery, body: `${delivery.body} ` });

    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { level: "error", message: "Webhook delivery refused", code: "webhook_signature_invalid" },
    ]);
  });

  it("answers 500 without applying when the delivery cannot be stored, so BuPayment retries", async () => {
    const { app, store } = await webhookApp();
    store.save = () => {
      throw new Error("disk full");
    };

    const response = await post(app, signed(ARCHIVED));

    expect(response.status).toBe(500);
    expect(response.body.code).toBe("internal_error");
  });

  it("refuses a delivery signed with another secret", async () => {
    const { app } = await webhookApp();

    const response = await post(app, signed(ARCHIVED, { secret: `whsec_${"x".repeat(40)}` }));

    expect(response.status).toBe(400);
  });

  it("refuses a delivery outside the accepted time window", async () => {
    const { app } = await webhookApp();

    const response = await post(app, signed(ARCHIVED, { timestamp: Date.now() - 3_600_000 }));

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("webhook_timestamp_expired");
  });

  it("refuses a delivery that is not JSON bytes", async () => {
    const { app } = await webhookApp();
    const delivery = signed(ARCHIVED);

    const response = await post(app, {
      ...delivery,
      headers: { ...delivery.headers, "content-type": "text/plain" },
    });

    expect(response.status).toBe(400);
  });

  it("answers a replayed delivery once and then as a duplicate", async () => {
    const { app } = await webhookApp();
    const delivery = signed(ARCHIVED, { deliveryId: "dlv_same" });

    const first = await post(app, delivery);
    const second = await post(app, delivery);

    expect([first.body.outcome, second.body.outcome]).toEqual(["applied", "duplicate"]);
  });

  it("sells the held unit when the checkout completes", async () => {
    const { app, store, lines } = await webhookApp();
    const held = store.load();
    held.reservations.A1 = "TICKET";
    held.checkouts.chk_1 = { orderId: "A1", sku: "TICKET", settled: null };
    store.save(held);
    const before = store.load().products;

    const response = await post(app, signed(checkoutEvent("checkout.completed")));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true, outcome: "applied" });
    expect(store.load().products).toEqual(before);
    expect(store.load().checkouts.chk_1?.settled).toBe("sold");
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      type: "checkout.completed",
      settlement: "sold",
    });
  });

  it("gives the held unit back when the checkout expires, and ignores the replay of another id", async () => {
    const { app, store, lines } = await webhookApp();
    const held = store.load();
    held.reservations.A1 = "TICKET";
    held.checkouts.chk_1 = { orderId: "A1", sku: "TICKET", settled: null };
    store.save(held);
    const stock = store.load().products.TICKET?.stock ?? 0;

    const expired = await post(app, signed(checkoutEvent("checkout.expired")));
    const again = await post(
      app,
      signed(checkoutEvent("checkout.cancelled"), { deliveryId: "dlv_2" }),
    );

    expect([expired.body.outcome, again.body.outcome]).toEqual(["applied", "ignored"]);
    expect(store.load().products.TICKET?.stock).toBe(stock + 1);
    expect(lines.map((line) => JSON.parse(line).settlement)).toEqual([
      "released",
      "already_settled",
    ]);
  });

  it("answers 503 when no endpoint secret is configured", async () => {
    const { app } = await webhookApp(null);

    const response = await post(app, signed(ARCHIVED));

    expect(response.status).toBe(503);
    expect(response.body.code).toBe("webhook_not_configured");
  });
});
