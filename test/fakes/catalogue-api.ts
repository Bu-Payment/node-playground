import type { FetchLike, Price, PriceInterval, Product } from "@bu-payment/node-sdk";

export const WRITTEN_AT = "2026-09-27T00:00:00.000Z";

export interface CatalogueApi {
  products: Product[];
  prices: Price[];
  requests: { url: URL; method: string; headers: Record<string, string>; body: unknown }[];
  unassigned: Set<string>;
  failArchive: boolean;
  failDefaultPrice: boolean;
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
    unassigned: new Set(),
    failArchive: false,
    failDefaultPrice: false,
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
      if (method === "PUT") {
        return moveDefault(api, url.pathname, body);
      }
      const single = /^\/v1\/(products|prices)\/([^/]+)$/.exec(url.pathname);
      if (single !== null) {
        const pool: { id: string }[] = single[1] === "products" ? api.products : api.prices;
        const found = pool.find((row) => row.id === decodeURIComponent(single[2] ?? ""));
        return found === undefined || api.unassigned.has(found.id)
          ? notFound()
          : Response.json(found);
      }
      const rows: (Product | Price)[] = url.pathname === "/v1/products" ? api.products : api.prices;
      const active = url.searchParams.get("active") !== "false";
      const productId = url.searchParams.get("productId");
      const matching = rows.filter(
        (row) =>
          row.active === active &&
          !api.unassigned.has(row.id) &&
          (productId === null || ("productId" in row && row.productId === productId)),
      );
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
    const owner = api.products.find((row) => row.id === productId);
    if (owner === undefined || api.unassigned.has(productId)) {
      return notFound();
    }
    const price = createdPrice(api, productId, body as PriceFields);
    api.prices.push(price);
    if (owner.defaultPriceId === null) {
      Object.assign(owner, { defaultPriceId: price.id, updatedAt: WRITTEN_AT });
    }
    return Response.json(price, { status: 201 });
  }
  const archived = /^\/v1\/prices\/([^/]+)\/archive$/.exec(path);
  const found = api.prices.find((row) => row.id === decodeURIComponent(archived?.[1] ?? ""));
  if (archived === null || found === undefined || api.unassigned.has(found.id)) {
    return notFound();
  }
  if (api.products.some((row) => row.defaultPriceId === found.id)) {
    return Response.json(
      { error: "default_price_in_use", message: "The default price cannot be archived" },
      { status: 409 },
    );
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

function moveDefault(api: CatalogueApi, path: string, body: unknown): Response {
  const moved = /^\/v1\/products\/([^/]+)\/default-price$/.exec(path);
  const owner = api.products.find((row) => row.id === decodeURIComponent(moved?.[1] ?? ""));
  if (moved === null || owner === undefined || api.unassigned.has(owner.id)) {
    return notFound();
  }
  if (api.failDefaultPrice) {
    return Response.json({ error: "operation_failed", message: "Unavailable" }, { status: 503 });
  }
  const { priceId, expectedUpdatedAt } = body as { priceId: string; expectedUpdatedAt?: string };
  if (!api.prices.some((row) => row.id === priceId && row.productId === owner.id)) {
    return Response.json(
      { error: "default_price_not_owned", message: "Not a price of this product" },
      { status: 409 },
    );
  }
  if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== owner.updatedAt) {
    return Response.json(
      { error: "stale_resource", message: "Stale", resource: owner },
      { status: 409 },
    );
  }
  Object.assign(owner, { defaultPriceId: priceId, updatedAt: WRITTEN_AT });
  return Response.json(owner);
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

function notFound(): Response {
  return Response.json({ error: "resource_not_found", message: "Not found" }, { status: 404 });
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
    defaultPriceId: null,
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
