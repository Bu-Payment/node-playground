import request from "supertest";
import { describe, expect, it } from "vitest";
import { putProduct } from "../../src/catalogue/merchant";
import { appWith } from "../fakes/app";
import { link, merchantProduct } from "../fakes/merchant";
import { singlePriceApi, twoPriceApi } from "../fakes/price-change";

describe("PUT /products/:sku/price", () => {
  it("changes a linked price through BuPayment", async () => {
    const { app, store } = appWith(
      [merchantProduct({ sku: "TICKET", bupayment: link() })],
      twoPriceApi().fetch,
    );

    const response = await request(app).put("/products/TICKET/price").send({ amount: 1800 });

    expect(response.status).toBe(200);
    expect(response.body.archivePending).toBe(false);
    expect(store.load().products.TICKET?.bupayment?.priceId).toBe("price_new_3");
  });

  it("reports and logs an archive left pending", async () => {
    const failing = twoPriceApi();
    failing.failArchive = true;
    const { app, lines } = appWith(
      [merchantProduct({ sku: "TICKET", bupayment: link() })],
      failing.fetch,
    );

    const response = await request(app).put("/products/TICKET/price").send({ amount: 1800 });

    expect(response.body.archivePending).toBe(true);
    expect(JSON.parse(lines[0] ?? "{}")).toEqual({
      level: "error",
      message: "Previous BuPayment price was not archived",
      sku: "TICKET",
      previousPriceId: "price_1",
      replacementPriceId: "price_new_3",
      outcome: "archive_failed",
      code: "operation_failed",
    });
  });

  it("reports and logs a default price that could not move", async () => {
    const failing = singlePriceApi();
    failing.failDefaultPrice = true;
    const { app, lines } = appWith(
      [merchantProduct({ sku: "TICKET", bupayment: link() })],
      failing.fetch,
    );

    const response = await request(app).put("/products/TICKET/price").send({ amount: 1800 });

    expect(response.body.archivePending).toBe(true);
    expect(JSON.parse(lines[0] ?? "{}")).toEqual({
      level: "error",
      message: "Previous BuPayment price was not archived",
      sku: "TICKET",
      previousPriceId: "price_1",
      replacementPriceId: "price_new_2",
      outcome: "default_failed",
      code: "operation_failed",
    });
  });

  it.each([
    [false, { level: "info", message: "Unused BuPayment price archived" }],
    [
      true,
      { level: "error", message: "Unused BuPayment price left active", code: "operation_failed" },
    ],
  ])("answers 409 and logs the unused price when the product changed meanwhile (archive fails: %s)", async (archiveFails, logged) => {
    const fake = twoPriceApi();
    const linked = merchantProduct({ sku: "TICKET", bupayment: link() });
    const { app, store, lines } = appWith([linked], fake.fetch);
    const load = store.load.bind(store);
    let loads = 0;
    store.load = () => {
      loads += 1;
      const catalogue = load();
      if (loads > 1) {
        fake.failArchive = archiveFails;
        putProduct(catalogue, { ...linked, bupayment: link({ priceId: "price_other" }) });
      }
      return catalogue;
    };

    const response = await request(app).put("/products/TICKET/price").send({ amount: 1800 });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("product_changed");
    expect(JSON.parse(lines[0] ?? "{}")).toEqual({
      ...logged,
      sku: "TICKET",
      priceId: "price_new_3",
    });
  });

  it("answers 404 for an unknown SKU", async () => {
    const { app } = appWith([], twoPriceApi().fetch);

    const response = await request(app).put("/products/TICKET/price").send({ amount: 1800 });

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("product_not_found");
  });

  it.each([
    { amount: -1 },
    { amount: 1.5 },
    { amount: 1800, currency: "USD" },
    {},
  ])("refuses %o", async (body) => {
    const { app } = appWith([merchantProduct({ sku: "TICKET" })], twoPriceApi().fetch);

    const response = await request(app).put("/products/TICKET/price").send(body);

    expect(response.status).toBe(422);
    expect(response.body.code).toBe("price_invalid");
  });
});
