import request from "supertest";
import { describe, expect, it } from "vitest";
import { emptyCatalogue, isSellable, putProduct } from "../../src/catalogue/merchant";
import { memoryStore } from "../../src/catalogue/store";
import { createApp } from "../../src/http/app";
import { product } from "../fakes/catalogue-api";
import { link, merchantProduct } from "../fakes/merchant";
import { productEvent, signed, WEBHOOK_SECRET } from "../fakes/webhook";
import { testContext } from "../fixtures";

const LATER = "2026-09-20T00:00:00.000Z";
const ARCHIVED = productEvent(
  "catalogue.product.archived.v1",
  product({ id: "prod_1", active: false, updatedAt: LATER }),
);

function webhookApp(secret: string | null = WEBHOOK_SECRET) {
  const catalogue = emptyCatalogue();
  putProduct(catalogue, merchantProduct({ sku: "TICKET", bupayment: link() }));
  const store = memoryStore(catalogue);
  const { context, lines } = testContext(
    secret === null ? {} : { BUPAYMENT_WEBHOOK_SECRET: secret },
  );
  return { app: createApp({ ...context, catalogue: store }), store, lines };
}

function post(app: ReturnType<typeof webhookApp>["app"], delivery: ReturnType<typeof signed>) {
  return request(app).post("/webhooks/bupayment").set(delivery.headers).send(delivery.body);
}

describe("POST /webhooks/bupayment", () => {
  it("applies a signed delivery", async () => {
    const { app, store, lines } = webhookApp();

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
    const { app } = webhookApp();
    const spaced = JSON.stringify(ARCHIVED, null, 2).replace("prod_1", "prod\\u005f1");

    const response = await post(app, signed(ARCHIVED, { body: spaced }));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true, outcome: "applied" });
  });

  it("refuses a tampered delivery and changes nothing", async () => {
    const { app, store } = webhookApp();
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

  it("refuses a delivery signed with another secret", async () => {
    const { app } = webhookApp();

    const response = await post(app, signed(ARCHIVED, { secret: `whsec_${"x".repeat(40)}` }));

    expect(response.status).toBe(400);
  });

  it("refuses a delivery outside the accepted time window", async () => {
    const { app } = webhookApp();

    const response = await post(app, signed(ARCHIVED, { timestamp: Date.now() - 3_600_000 }));

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("webhook_timestamp_expired");
  });

  it("refuses a delivery that is not JSON bytes", async () => {
    const { app } = webhookApp();
    const delivery = signed(ARCHIVED);

    const response = await post(app, {
      ...delivery,
      headers: { ...delivery.headers, "content-type": "text/plain" },
    });

    expect(response.status).toBe(400);
  });

  it("answers a replayed delivery once and then as a duplicate", async () => {
    const { app } = webhookApp();
    const delivery = signed(ARCHIVED, { deliveryId: "dlv_same" });

    const first = await post(app, delivery);
    const second = await post(app, delivery);

    expect([first.body.outcome, second.body.outcome]).toEqual(["applied", "duplicate"]);
  });

  it("answers 503 when no endpoint secret is configured", async () => {
    const { app } = webhookApp(null);

    const response = await post(app, signed(ARCHIVED));

    expect(response.status).toBe(503);
    expect(response.body.code).toBe("webhook_not_configured");
  });
});
