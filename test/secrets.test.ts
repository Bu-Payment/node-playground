import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FetchLike, Header } from "@bu-payment/node-sdk";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { runReconciliation } from "../src/catalogue/command";
import { emptyCatalogue, putProduct } from "../src/catalogue/merchant";
import { memoryStore } from "../src/catalogue/store";
import { createApp } from "../src/http/app";
import { fakeCatalogueApi, product } from "./fakes/catalogue-api";
import { link, merchantProduct } from "./fakes/merchant";
import { FAKE_SECRET, testContext, testLogger, VALID_ENV } from "./fixtures";

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
    const app = createApp({ ...context, catalogue: memoryStore(catalogue) });

    const response = await request(app).get("/catalogue");

    expect(response.status).toBe(200);
    expect(response.text).not.toContain(FAKE_SECRET);
    expect(lines.join("\n")).not.toContain(FAKE_SECRET);
  });

  it("stays out of the log and the responses of every catalogue route", async () => {
    const { context, lines } = testContext();
    const app = createApp(context);

    const responses = await Promise.all([
      request(app).get("/catalogue"),
      request(app).post("/products").send({ sku: FAKE_SECRET, title: FAKE_SECRET }),
      request(app)
        .put(`/products/${FAKE_SECRET}/link`)
        .send({ productId: FAKE_SECRET, priceId: FAKE_SECRET, pricing: "stored" }),
      request(app).post("/products").set("Content-Type", "application/json").send("{"),
    ]);

    expect(responses.map((response) => response.text).join("\n")).not.toContain(FAKE_SECRET);
    expect(lines.join("\n")).not.toContain(FAKE_SECRET);
  });
});
