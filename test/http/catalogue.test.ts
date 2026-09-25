import request from "supertest";
import { describe, expect, it } from "vitest";
import { applyPrice, applyProduct, emptyMirror } from "../../src/catalogue/mirror";
import { memoryStore } from "../../src/catalogue/store";
import { createApp } from "../../src/http/app";
import { price, product, unreachableApi } from "../fakes/catalogue-api";
import { testContext } from "../fixtures";

function mirroredApp() {
  const mirror = emptyMirror();
  applyProduct(mirror, product({ id: "prod_ticket", name: "Ticket" }));
  applyProduct(mirror, product({ id: "prod_archived", name: "Archived", active: false }));
  applyPrice(
    mirror,
    price({ id: "price_ticket", productId: "prod_ticket", unitAmount: 1500 }),
    "2026-09-24T12:00:00.000Z",
  );
  applyPrice(
    mirror,
    price({ id: "price_old", productId: "prod_ticket", active: false }),
    "2026-09-24T12:00:00.000Z",
  );
  const { context } = testContext({}, { fetch: unreachableApi() });
  const store = memoryStore(mirror);
  return { app: createApp({ ...context, catalogue: store }), store };
}

describe("GET /catalogue", () => {
  it("serves the storefront from the mirror while BuPayment is unreachable", async () => {
    const { app } = mirroredApp();

    const response = await request(app).get("/catalogue");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      products: [
        {
          id: "prod_ticket",
          name: "Ticket",
          description: null,
          imageUrl: null,
          prices: [
            {
              id: "price_ticket",
              type: "one_time",
              interval: null,
              intervalCount: null,
              display: {
                unitAmount: 1500,
                currency: "EUR",
                syncedAt: "2026-09-24T12:00:00.000Z",
              },
            },
          ],
        },
      ],
    });
  });

  it("orders products by name", async () => {
    const mirror = emptyMirror();
    applyProduct(mirror, product({ id: "prod_b", name: "Bravo" }));
    applyProduct(mirror, product({ id: "prod_a", name: "Alpha" }));
    const { context } = testContext();

    const response = await request(createApp({ ...context, catalogue: memoryStore(mirror) })).get(
      "/catalogue",
    );

    expect(response.body.products.map((row: { name: string }) => row.name)).toEqual([
      "Alpha",
      "Bravo",
    ]);
  });
});

describe("PUT /catalogue/products/:productId/image", () => {
  it("stores a local-only image on a mirrored product", async () => {
    const { app, store } = mirroredApp();

    const response = await request(app)
      .put("/catalogue/products/prod_ticket/image")
      .send({ imageUrl: "https://cdn.example.test/ticket.png" });

    expect(response.status).toBe(204);
    expect(store.load().products.prod_ticket?.imageUrl).toBe("https://cdn.example.test/ticket.png");
  });

  it("clears the image with null", async () => {
    const { app, store } = mirroredApp();
    await request(app)
      .put("/catalogue/products/prod_ticket/image")
      .send({ imageUrl: "https://cdn.example.test/ticket.png" });

    await request(app).put("/catalogue/products/prod_ticket/image").send({ imageUrl: null });

    expect(store.load().products.prod_ticket?.imageUrl).toBeNull();
  });

  it("refuses a product the mirror does not hold", async () => {
    const { app } = mirroredApp();

    const response = await request(app)
      .put("/catalogue/products/prod_unknown/image")
      .send({ imageUrl: "https://cdn.example.test/x.png" });

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("product_not_mirrored");
  });

  it.each([
    { imageUrl: "javascript:alert(1)" },
    { imageUrl: 42 },
    {},
  ])("refuses %o as an image", async (body) => {
    const { app, store } = mirroredApp();

    const response = await request(app).put("/catalogue/products/prod_ticket/image").send(body);

    expect(response.status).toBe(422);
    expect(response.body.code).toBe("request_invalid");
    expect(store.load().products.prod_ticket?.imageUrl).toBeNull();
  });
});
