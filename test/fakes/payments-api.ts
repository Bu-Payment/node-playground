import {
  type Customer,
  type ExpectedPrice,
  type FetchLike,
  Header,
  type Payment,
} from "@bu-payment/node-sdk";
import {
  type CatalogueApi,
  decodeBody,
  fakeCatalogueApi,
  price,
  product,
  WRITTEN_AT,
} from "./catalogue-api";

export interface PaymentsApi {
  catalogue: CatalogueApi;
  customers: Customer[];
  payments: Payment[];
  charges: {
    customerId: string;
    priceId: string;
    expectedPrice?: ExpectedPrice;
    idempotencyKey: string | undefined;
  }[];
  paymentStatus: string;
  failure: Response | null;
  fetch: FetchLike;
}

export function fakePaymentsApi(catalogue: CatalogueApi = oneTimeCatalogue()): PaymentsApi {
  const replays = new Map<string, Payment>();
  const api: PaymentsApi = {
    catalogue,
    customers: [],
    payments: [],
    charges: [],
    paymentStatus: "succeeded",
    failure: null,
    fetch: async (input, init) => {
      const url = new URL(input);
      const method = init.method ?? "GET";
      if (url.pathname === "/v1/customers") {
        return method === "POST"
          ? createCustomer(api, decodeBody(init.body) as { email: string })
          : listCustomers(api, url.searchParams.get("email"));
      }
      if (url.pathname === "/v1/payments" && method === "POST") {
        const key = (init.headers as Record<string, string>)[Header.IDEMPOTENCY_KEY];
        return api.failure?.clone() ?? charge(api, replays, key, decodeBody(init.body) as Charge);
      }
      return catalogue.fetch(input, init);
    },
  };
  return api;
}

export function oneTimeCatalogue(unitAmount = 2750): CatalogueApi {
  return fakeCatalogueApi({
    products: [product({ id: "prod_1", defaultPriceId: "price_1" })],
    prices: [price({ id: "price_1", productId: "prod_1", unitAmount })],
  });
}

interface Charge {
  customerId: string;
  priceId: string;
  expectedPrice?: ExpectedPrice;
  reference?: string;
}

function listCustomers(api: PaymentsApi, email: string | null): Response {
  const data = api.customers.filter((row) => email === null || row.email === email);
  return Response.json({ data, nextCursor: null });
}

function createCustomer(api: PaymentsApi, body: { email: string }): Response {
  const customer: Customer = {
    id: `cus_${api.customers.length + 1}`,
    email: body.email,
    name: null,
    createdAt: WRITTEN_AT,
    updatedAt: WRITTEN_AT,
  };
  api.customers.push(customer);
  return Response.json(customer, { status: 201 });
}

function charge(
  api: PaymentsApi,
  replays: Map<string, Payment>,
  idempotencyKey: string | undefined,
  body: Charge,
): Response {
  api.charges.push({
    customerId: body.customerId,
    priceId: body.priceId,
    ...(body.expectedPrice === undefined ? {} : { expectedPrice: body.expectedPrice }),
    idempotencyKey,
  });
  const replayed = idempotencyKey === undefined ? undefined : replays.get(idempotencyKey);
  if (replayed !== undefined) {
    return Response.json(replayed, { status: 201 });
  }
  const current = api.catalogue.prices.find((row) => row.id === body.priceId);
  if (current === undefined) {
    return Response.json({ error: "resource_not_found", message: "Not found" }, { status: 404 });
  }
  const expected = body.expectedPrice;
  if (
    expected !== undefined &&
    (expected.unitAmount !== current.unitAmount || expected.currency !== current.currency)
  ) {
    return Response.json(
      {
        error: "price_changed",
        message: "The price no longer matches the amount the caller displayed",
        price: {
          id: current.id,
          unitAmount: current.unitAmount,
          currency: current.currency,
          active: current.active,
          updatedAt: current.updatedAt,
        },
      },
      { status: 409 },
    );
  }
  const payment: Payment = {
    id: `pay_${api.payments.length + 1}`,
    status: api.paymentStatus,
    amount: current.unitAmount,
    currency: current.currency,
    provider: "test",
    reference: body.reference ?? null,
    description: null,
    refundedAmount: 0,
    customerId: body.customerId,
    invoiceId: null,
    subscriptionId: null,
    createdAt: WRITTEN_AT,
    updatedAt: WRITTEN_AT,
  };
  api.payments.push(payment);
  if (idempotencyKey !== undefined) {
    replays.set(idempotencyKey, payment);
  }
  return Response.json(payment, { status: 201 });
}
