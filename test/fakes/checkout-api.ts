import { type Checkout, type FetchLike, Header } from "@bu-payment/node-sdk";
import { decodeBody, WRITTEN_AT } from "./catalogue-api";
import { fakePaymentsApi, type PaymentsApi } from "./payments-api";

export const CHECKOUT_URL = "https://api.example.test/public/v1/checkouts/pay/tok_secret";

export interface CheckoutRequest {
  body: Record<string, unknown>;
  idempotencyKey: string | undefined;
}

export interface HostedCheckoutApi {
  payments: PaymentsApi;
  directCharges: number;
  requests: CheckoutRequest[];
  failure: Response | "network" | null;
  fetch: FetchLike;
}

export function fakeHostedCheckoutApi(
  payments: PaymentsApi = fakePaymentsApi(),
): HostedCheckoutApi {
  payments.failure = Response.json(
    { error: "provider_capability_not_supported", message: "No direct charges" },
    { status: 422 },
  );
  const replays = new Map<string, Checkout>();
  const api: HostedCheckoutApi = {
    payments,
    directCharges: 0,
    requests: [],
    failure: null,
    fetch: async (input, init) => {
      const url = new URL(input);
      if (url.pathname === "/v1/payments") {
        api.directCharges += 1;
      }
      if (url.pathname !== "/v1/checkouts" || init.method !== "POST") {
        return payments.fetch(input, init);
      }
      const idempotencyKey = (init.headers as Record<string, string>)[Header.IDEMPOTENCY_KEY];
      const body = decodeBody(init.body) as Record<string, unknown>;
      api.requests.push({ body, idempotencyKey });
      if (api.failure === "network") {
        throw new TypeError("fetch failed");
      }
      if (api.failure !== null) {
        return api.failure.clone();
      }
      const checkout =
        (idempotencyKey === undefined ? undefined : replays.get(idempotencyKey)) ??
        openCheckout(replays.size + 1, body);
      if (idempotencyKey !== undefined) {
        replays.set(idempotencyKey, checkout);
      }
      return Response.json(checkout, { status: 201 });
    },
  };
  return api;
}

export function withoutDefaultProvider(api: HostedCheckoutApi): HostedCheckoutApi {
  api.payments.failure = Response.json(
    { error: "default_provider_not_configured", message: "Choose one for the environment." },
    { status: 409 },
  );
  return api;
}

function openCheckout(sequence: number, body: Record<string, unknown>): Checkout {
  return {
    id: `chk_${sequence}`,
    status: "pending",
    provider: typeof body.provider === "string" ? body.provider : "trust-my-travel",
    checkoutUrl: CHECKOUT_URL,
    reference: typeof body.reference === "string" ? body.reference : null,
    amount: 2750,
    currency: "EUR",
    chargedAmount: null,
    chargedCurrency: null,
    quantity: 1,
    customerId: "cus_1",
    expiresAt: "2026-10-09T13:00:00.000Z",
    createdAt: WRITTEN_AT,
    updatedAt: WRITTEN_AT,
  };
}
