import type { FetchLike } from "@bu-payment/node-sdk";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { emptyCatalogue, type MerchantProduct, putProduct } from "../../src/catalogue/merchant";
import { memoryStore } from "../../src/catalogue/store";
import { createApp } from "../../src/http/app";
import { fakeCatalogueApi, price, product, unreachableApi } from "../fakes/catalogue-api";
import { link, merchantProduct } from "../fakes/merchant";
import { testContext } from "../fixtures";

function appWith(products: MerchantProduct[], fetch: FetchLike = unreachableApi()) {
  const catalogue = emptyCatalogue();
  for (const entry of products) {
    putProduct(catalogue, entry);
  }
  const store = memoryStore(catalogue);
  const { context } = testContext({}, { fetch });
  return { app: createApp({ ...context, catalogue: store }), store };
}

const LIVE = merchantProduct({
  sku: "PASS",
  title: "Pass",
  pricing: {
    mode: "live",
    lastKnown: { amount: 900, currency: "EUR", readAt: "2026-09-01T00:00:00Z" },
  },
  bupayment: link(),
});

describe("GET /catalogue", () => {
  it("serves stored prices and the merchant's own fields with BuPayment unreachable", async () => {
    const { app } = appWith([
      merchantProduct({
        sku: "TICKET",
        title: "Ticket",
        imageUrl: "https://cdn.example.test/t.png",
        bupayment: link(),
      }),
      merchantProduct({ sku: "LOCAL", title: "Local only" }),
    ]);

    const response = await request(app).get("/catalogue");

    expect(response.status).toBe(200);
    expect(response.body.products).toEqual([
      {
        sku: "LOCAL",
        title: "Local only",
        slug: "local",
        imageUrl: null,
        stock: 10,
        price: { amount: 1500, currency: "EUR", source: "stored", readAt: null },
        sellable: false,
      },
      {
        sku: "TICKET",
        title: "Ticket",
        slug: "ticket",
        imageUrl: "https://cdn.example.test/t.png",
        stock: 10,
        price: { amount: 1500, currency: "EUR", source: "stored", readAt: null },
        sellable: true,
      },
    ]);
  });

  it("reads a live price from BuPayment and remembers it", async () => {
    const api = fakeCatalogueApi({
      prices: [price({ id: "price_1", productId: "prod_1", unitAmount: 1200 })],
    });
    const { app, store } = appWith([LIVE], api.fetch);

    const response = await request(app).get("/catalogue");

    expect(response.body.products[0].price).toEqual({
      amount: 1200,
      currency: "EUR",
      source: "live",
      readAt: null,
    });
    expect(store.load().products.PASS?.pricing).toMatchObject({
      mode: "live",
      lastKnown: { amount: 1200, currency: "EUR" },
    });
  });

  it("falls back to the last known live price when BuPayment is unreachable", async () => {
    const { app } = appWith([LIVE]);

    const response = await request(app).get("/catalogue");

    expect(response.status).toBe(200);
    expect(response.body.products[0].price).toEqual({
      amount: 900,
      currency: "EUR",
      source: "last_known",
      readAt: "2026-09-01T00:00:00Z",
    });
  });

  it("shows no price for a live product never read and BuPayment unreachable", async () => {
    const { app } = appWith([{ ...LIVE, pricing: { mode: "live", lastKnown: null } }]);

    expect((await request(app).get("/catalogue")).body.products[0].price).toBeNull();
  });
});

describe("POST /products", () => {
  const body = {
    sku: "TICKET",
    title: "Ferry ticket",
    slug: "ferry-ticket",
    stock: 5,
    price: { amount: 1500, currency: "EUR" },
  };

  it("creates an unlinked product with a local price", async () => {
    const { app, store } = appWith([]);

    const response = await request(app).post("/products").send(body);

    expect(response.status).toBe(201);
    expect(store.load().products.TICKET).toEqual({
      sku: "TICKET",
      title: "Ferry ticket",
      slug: "ferry-ticket",
      imageUrl: null,
      stock: 5,
      pricing: { mode: "stored", amount: 1500, currency: "EUR" },
      bupayment: null,
    });
  });

  it("refuses a SKU that already exists", async () => {
    const { app } = appWith([merchantProduct({ sku: "TICKET" })]);

    const response = await request(app).post("/products").send(body);

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("product_exists");
  });

  it.each([
    { ...body, sku: "has space" },
    { ...body, imageUrl: "javascript:alert(1)" },
    { ...body, price: { amount: -1, currency: "EUR" } },
    { ...body, price: { amount: 1, currency: "eur" } },
  ])("refuses %o", async (invalid) => {
    const { app, store } = appWith([]);

    const response = await request(app).post("/products").send(invalid);

    expect(response.status).toBe(422);
    expect(response.body.code).toBe("product_invalid");
    expect(store.load().products).toEqual({});
  });
});

describe("PUT /products/:sku/link", () => {
  const api = () =>
    fakeCatalogueApi({
      products: [product({ id: "prod_1" }), product({ id: "prod_2" })],
      prices: [price({ id: "price_1", productId: "prod_1", unitAmount: 1800 })],
    });

  it("links a local product to a BuPayment product and price", async () => {
    const { app, store } = appWith([merchantProduct({ sku: "TICKET" })], api().fetch);

    const response = await request(app)
      .put("/products/TICKET/link")
      .send({ productId: "prod_1", priceId: "price_1", pricing: "stored" });

    expect(response.status).toBe(200);
    expect(store.load().products.TICKET?.bupayment?.priceId).toBe("price_1");
  });

  it.each(["__proto__", "UNKNOWN"])("answers 404 for the local SKU %s", async (sku) => {
    const { app } = appWith([merchantProduct({ sku: "TICKET" })], api().fetch);

    const response = await request(app)
      .put(`/products/${sku}/link`)
      .send({ productId: "prod_1", priceId: "price_1", pricing: "stored" });

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("product_not_found");
  });

  it("refuses a price of another product", async () => {
    const { app } = appWith([merchantProduct({ sku: "TICKET" })], api().fetch);

    const response = await request(app)
      .put("/products/TICKET/link")
      .send({ productId: "prod_2", priceId: "price_1", pricing: "stored" });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe("price_not_of_product");
  });

  it("refuses an archived BuPayment price", async () => {
    const archived = fakeCatalogueApi({
      products: [product({ id: "prod_1" })],
      prices: [price({ id: "price_1", productId: "prod_1", active: false })],
    });
    const { app } = appWith([merchantProduct({ sku: "TICKET" })], archived.fetch);

    const response = await request(app)
      .put("/products/TICKET/link")
      .send({ productId: "prod_1", priceId: "price_1", pricing: "live" });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe("inactive");
  });

  it("refuses a malformed link request", async () => {
    const { app } = appWith([merchantProduct({ sku: "TICKET" })], api().fetch);

    const response = await request(app)
      .put("/products/TICKET/link")
      .send({ productId: "prod_1", priceId: "price_1", pricing: "cached" });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe("link_invalid");
  });

  it("maps a BuPayment 404 to the canonical SDK failure", async () => {
    const { app } = appWith([merchantProduct({ sku: "TICKET" })], api().fetch);

    const response = await request(app)
      .put("/products/TICKET/link")
      .send({ productId: "prod_missing", priceId: "price_1", pricing: "stored" });

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("resource_not_found");
  });
});
