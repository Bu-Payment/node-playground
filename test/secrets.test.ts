import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FetchLike, Header } from "@bu-payment/node-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { runReconciliation } from "../src/catalogue/command";
import { emptyCatalogue, putProduct } from "../src/catalogue/merchant";
import { memoryStore } from "../src/catalogue/store";
import { createApp } from "../src/http/app";
import { fakeCatalogueApi, product } from "./fakes/catalogue-api";
import { fakeHostedCheckoutApi, withoutDefaultProvider } from "./fakes/checkout-api";
import { link, merchantProduct } from "./fakes/merchant";
import { fakePaymentsApi, oneTimeCatalogue } from "./fakes/payments-api";
import { productEvent, signed, WEBHOOK_SECRET } from "./fakes/webhook";
import { FAKE_SECRET, testContext, testLogger, VALID_ENV } from "./fixtures";
import { serve } from "./serve";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function environment() {
  const directory = mkdtempSync(join(tmpdir(), "playground-secrets-"));
  directories.push(directory);
  return { ...VALID_ENV, CATALOGUE_STORE_PATH: join(directory, "catalogue.json") };
}

const leakingFailures: Record<string, FetchLike> = {
  "a network error quoting the secret": async () => {
    throw new TypeError(`connect failed with ${FAKE_SECRET}`);
  },
  "an API error body quoting the secret": async () =>
    Response.json(
      { error: "application_auth_invalid", message: `bad secret ${FAKE_SECRET}` },
      { status: 401 },
    ),
  "a malformed API response quoting the secret": async () =>
    new Response(`not json ${FAKE_SECRET}`, { status: 200 }),
};

describe("the confidential secret", () => {
  it("is used to sign the sweep without ever reaching the log", async () => {
    const { lines, logger } = testLogger();
    const api = fakeCatalogueApi({ products: [product({ id: "prod_1" })] });

    await runReconciliation(logger, environment(), { fetch: api.fetch });

    expect(api.requests[0]?.headers[Header.SIGNATURE]).toMatch(/\S/);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(FAKE_SECRET);
    expect(JSON.stringify(api.requests)).not.toContain(FAKE_SECRET);
  });

  it.each(
    Object.entries(leakingFailures),
  )("stays out of the log when reconciliation fails with %s", async (_, fetch) => {
    const { lines, logger } = testLogger();

    const code = await runReconciliation(logger, environment(), { fetch });

    expect(code).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines.join("\n")).not.toContain(FAKE_SECRET);
  });

  it("stays out of the log when reconciliation cannot start", async () => {
    const { lines, logger } = testLogger();

    const code = await runReconciliation(logger, {
      ...environment(),
      BUPAYMENT_SECRET: `${FAKE_SECRET}!`,
    });

    expect(code).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines.join("\n")).not.toContain(FAKE_SECRET);
  });

  it.each(
    Object.entries(leakingFailures),
  )("stays out of the storefront when a live price read fails with %s", async (_, fetch) => {
    const catalogue = emptyCatalogue();
    putProduct(
      catalogue,
      merchantProduct({
        sku: "PASS",
        pricing: { mode: "live", lastKnown: null },
        bupayment: link(),
      }),
    );
    const { context, lines } = testContext({}, { fetch });
    const app = await serve(createApp({ ...context, catalogue: memoryStore(catalogue) }));

    const response = await app.get("/catalogue");

    expect(response.status).toBe(200);
    expect(response.text).not.toContain(FAKE_SECRET);
    expect(lines.join("\n")).not.toContain(FAKE_SECRET);
  });

  it("stays out of the log and the responses of every catalogue route", async () => {
    const { context, lines } = testContext();
    const app = await serve(createApp(context));

    const responses = await Promise.all([
      app.get("/catalogue"),
      app.post("/products").send({ sku: FAKE_SECRET, title: FAKE_SECRET }),
      app
        .put(`/products/${FAKE_SECRET}/link`)
        .send({ productId: FAKE_SECRET, priceId: FAKE_SECRET, pricing: "stored" }),
      app.post("/products").set("Content-Type", "application/json").send("{"),
    ]);

    expect(responses.map((response) => response.text).join("\n")).not.toContain(FAKE_SECRET);
    expect(lines.join("\n")).not.toContain(FAKE_SECRET);
  });

  it.each(
    Object.entries(leakingFailures),
  )("stays out of the checkout response and log when BuPayment fails with %s", async (_, fetch) => {
    const { context, lines } = testContext({}, { fetch });
    const app = await serve(createApp({ ...context, catalogue: memoryStore(sellableCatalogue()) }));

    const response = await app
      .post("/checkout")
      .send({ orderId: "A1", sku: "TSHIRT", email: "buyer@example.test" });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.text).not.toContain(FAKE_SECRET);
    expect(lines.join("\n")).not.toContain(FAKE_SECRET);
  });

  it("stays out of the checkout refusals and the requests that sign them", async () => {
    const api = fakePaymentsApi(oneTimeCatalogue(3000));
    const { context, lines } = testContext({}, { fetch: api.fetch });
    const app = await serve(createApp({ ...context, catalogue: memoryStore(sellableCatalogue()) }));

    const responses = await Promise.all([
      app.post("/checkout").send({ orderId: "A1", sku: "TSHIRT", email: "buyer@example.test" }),
      app.post("/checkout").send({ orderId: FAKE_SECRET, sku: FAKE_SECRET, email: FAKE_SECRET }),
      app.post("/checkout").set("Content-Type", "application/json").send("{"),
    ]);

    expect(responses.map((response) => response.status)).toEqual([409, 422, 400]);
    expect(responses.map((response) => response.text).join("\n")).not.toContain(FAKE_SECRET);
    expect(lines.join("\n")).not.toContain(FAKE_SECRET);
    expect(JSON.stringify(api.catalogue.requests)).not.toContain(FAKE_SECRET);
  });

  it("stays out of the answers and log when the environment has no default provider", async () => {
    const api = withoutDefaultProvider(fakeHostedCheckoutApi(), `no default for ${FAKE_SECRET}`);
    api.failure = Response.json(
      { error: "checkout_live_not_enabled", message: `refused ${FAKE_SECRET}` },
      { status: 409 },
    );
    const order = { orderId: "A1", sku: "TSHIRT", email: "buyer@example.test" };
    const withProvider = testContext(
      { BUPAYMENT_CHECKOUT_DESTINATION: "tours", BUPAYMENT_CHECKOUT_PROVIDER: "trust-my-travel" },
      { fetch: api.fetch },
    );
    const withoutProvider = testContext({}, { fetch: api.fetch });

    const responses = await Promise.all(
      [withProvider, withoutProvider].map(async ({ context }) =>
        (await serve(createApp({ ...context, catalogue: memoryStore(sellableCatalogue()) })))
          .post("/checkout")
          .send(order),
      ),
    );

    expect(responses.map((response) => response.status)).toEqual([502, 503]);
    const lines = [...withProvider.lines, ...withoutProvider.lines];
    const everything = [...responses.map((response) => response.text), ...lines].join("\n");
    expect(everything).not.toContain(FAKE_SECRET);
    expect(JSON.stringify(api.requests)).not.toContain(FAKE_SECRET);
  });

  it("keeps the webhook endpoint secret out of the log and every webhook response", async () => {
    const { context, lines } = testContext({ BUPAYMENT_WEBHOOK_SECRET: WEBHOOK_SECRET });
    const app = await serve(createApp(context));
    const event = productEvent(
      "catalogue.product.archived.v1",
      product({ id: "prod_1", active: false }),
    );
    const valid = signed(event);

    const responses = await Promise.all([
      app.post("/webhooks/bupayment").set(valid.headers).send(valid.body),
      app
        .post("/webhooks/bupayment")
        .set({ ...valid.headers, "x-webhook-signature": WEBHOOK_SECRET })
        .send(valid.body),
      app
        .post("/webhooks/bupayment")
        .set(valid.headers)
        .send(valid.body.replace("prod_1", WEBHOOK_SECRET)),
    ]);

    const everything = [...responses.map((response) => response.text), ...lines].join("\n");
    expect(everything).not.toContain(WEBHOOK_SECRET);
    expect(everything).not.toContain(FAKE_SECRET);
  });
});

function sellableCatalogue() {
  const catalogue = emptyCatalogue();
  putProduct(
    catalogue,
    merchantProduct({
      sku: "TSHIRT",
      pricing: { mode: "stored", amount: 2750, currency: "EUR" },
      bupayment: link(),
    }),
  );
  return catalogue;
}
