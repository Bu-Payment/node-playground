import type { FetchLike, Price, Product } from "@bu-payment/node-sdk";

export interface CatalogueApi {
  products: Product[];
  prices: Price[];
  requests: { url: URL; headers: Record<string, string> }[];
  fetch: FetchLike;
}

export function fakeCatalogueApi(
  seed: { products?: Product[]; prices?: Price[] } = {},
  pageSize = 2,
): CatalogueApi {
  const api: CatalogueApi = {
    products: seed.products ?? [],
    prices: seed.prices ?? [],
    requests: [],
    fetch: async (input, init) => {
      const url = new URL(input);
      api.requests.push({ url, headers: { ...(init.headers as Record<string, string>) } });
      const single = /^\/v1\/(products|prices)\/([^/]+)$/.exec(url.pathname);
      if (single !== null) {
        const pool: { id: string }[] = single[1] === "products" ? api.products : api.prices;
        const found = pool.find((row) => row.id === decodeURIComponent(single[2] ?? ""));
        return found === undefined
          ? Response.json({ error: "resource_not_found", message: "Not found" }, { status: 404 })
          : Response.json(found);
      }
      const rows = url.pathname === "/v1/products" ? api.products : api.prices;
      const active = url.searchParams.get("active") !== "false";
      const matching = rows.filter((row) => row.active === active);
      const offset = Number(url.searchParams.get("cursor") ?? "0");
      const end = offset + pageSize;
      return Response.json({
        data: matching.slice(offset, end),
        nextCursor: end < matching.length ? String(end) : null,
      });
    },
  };
  return api;
}

export function unreachableApi(): FetchLike {
  return async () => {
    throw new TypeError("fetch failed");
  };
}

export function product(overrides: Partial<Product> & Pick<Product, "id">): Product {
  return {
    name: `Product ${overrides.id}`,
    description: null,
    active: true,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

export function price(overrides: Partial<Price> & Pick<Price, "id" | "productId">): Price {
  return {
    unitAmount: 1500,
    currency: "EUR",
    type: "one_time",
    recurring: null,
    description: null,
    lookupKey: null,
    active: true,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}
