import type { FetchLike, Price, PriceInterval, Product } from "@bu-payment/node-sdk";

export const WRITTEN_AT = "2026-09-27T00:00:00.000Z";

export interface CatalogueApi {
  products: Product[];
  prices: Price[];
  requests: { url: URL; method: string; headers: Record<string, string>; body: unknown }[];
  failArchive: boolean;
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
    failArchive: false,
    fetch: async (input, init) => {
      const url = new URL(input);
      const method = init.method ?? "GET";
      const body = decodeBody(init.body);
      api.requests.push({
        url,
        method,
        headers: { ...(init.headers as Record<string, string>) },
        body,
      });
      if (method === "POST") {
        return write(api, url.pathname, body);
      }
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

function write(api: CatalogueApi, path: string, body: unknown): Response {
  const created = /^\/v1\/products\/([^/]+)\/prices$/.exec(path);
  if (created !== null) {
    const productId = decodeURIComponent(created[1] ?? "");
    if (!api.products.some((row) => row.id === productId)) {
      return Response.json({ error: "resource_not_found", message: "Not found" }, { status: 404 });
    }
    const price = createdPrice(api, productId, body as PriceFields);
    api.prices.push(price);
    return Response.json(price, { status: 201 });
  }
  const archived = /^\/v1\/prices\/([^/]+)\/archive$/.exec(path);
  const found = api.prices.find((row) => row.id === decodeURIComponent(archived?.[1] ?? ""));
  if (archived === null || found === undefined) {
    return Response.json({ error: "resource_not_found", message: "Not found" }, { status: 404 });
  }
  if (api.failArchive) {
    return Response.json({ error: "operation_failed", message: "Unavailable" }, { status: 503 });
  }
  const expected = (body as { expectedUpdatedAt?: string } | undefined)?.expectedUpdatedAt;
  if (expected !== undefined && expected !== found.updatedAt) {
    return Response.json(
      { error: "stale_resource", message: "Stale", resource: found },
      { status: 409 },
    );
  }
  Object.assign(found, { active: false, updatedAt: WRITTEN_AT });
  return Response.json(found);
}

interface PriceFields {
  unitAmount: number;
  currency: string;
  recurring?: { interval: PriceInterval; intervalCount?: number };
}

function createdPrice(api: CatalogueApi, productId: string, fields: PriceFields): Price {
  const recurring =
    fields.recurring === undefined
      ? null
      : { interval: fields.recurring.interval, intervalCount: fields.recurring.intervalCount ?? 1 };
  return {
    id: `price_new_${api.prices.length + 1}`,
    productId,
    unitAmount: fields.unitAmount,
    currency: fields.currency,
    type: recurring === null ? "one_time" : "recurring",
    recurring,
    description: null,
    lookupKey: null,
    active: true,
    createdAt: WRITTEN_AT,
    updatedAt: WRITTEN_AT,
  };
}

function decodeBody(body: RequestInit["body"]): unknown {
  if (body === undefined || body === null) {
    return undefined;
  }
  const text = typeof body === "string" ? body : new TextDecoder().decode(body as Uint8Array);
  return JSON.parse(text);
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
    lookupKey: null,
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
