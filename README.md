# BuPayment Node Playground

A server-side Test harness for exploring the official BuPayment Node SDK. It holds the confidential
key, signs requests with the versioned BuPayment HMAC protocol, and talks to the authenticated API.

This repository is the server sibling of the [browser playground](https://github.com/Bu-Payment/playground).
That one carries only the publishable key and runs in a browser. This one is the opposite: nothing
here is ever bundled, served, or otherwise handed to a browser, and no value in this repository
belongs in a variable with a bundler prefix such as `VITE_`.

The separation is the point. A confidential secret and a browser bundle in the same repository is
one careless import away from shipping the secret to every visitor.

## Status

The playground keeps its own product catalogue, in its own shape, and links each product to a
BuPayment product and price by reference. It follows BuPayment through a reconciliation sweep and
catalogue webhooks, and changes a linked price through BuPayment first. See [Catalogue](#catalogue).

It sells a linked product at the price the storefront displayed, and BuPayment refuses the charge
when the canonical price changed since ([api#444](https://github.com/Bu-Payment/api/issues/444)).
When the provider cannot charge directly, it opens a hosted one-time checkout instead and settles the
order from the `checkout.*` webhooks. See [Checkout](#checkout).

## Run locally

```sh
bun install
cp .env.example .env
bun run dev
```

`bun run dev` runs the source under Bun, which loads `.env` itself. The compiled entry point is plain
Node and does not, so `bun run start` passes `--env-file-if-exists=.env`. The flag tolerates a
missing file, because in a container or in CI the configuration arrives through the process
environment and there is no `.env` on disk. It needs Node 20.12 or later. Build before starting:

```sh
bun run build
bun run start
```

The server listens on <http://127.0.0.1:9003>. Port 9003 avoids the API on 3000, its TLS listener on
3443, the dashboard on 9000, the admin on 9001, and the browser playground on 9002.

## Configuration

Every variable is required except `HOST`, `PORT`, `CATALOGUE_STORE_PATH`,
`BUPAYMENT_WEBHOOK_SECRET`, `BUPAYMENT_CHECKOUT_DESTINATION` and `BUPAYMENT_CHECKOUT_PROVIDER`; a
blank one counts as unset. Boot happens in two stages, and the error you
get says which stage failed. First the environment is checked for shape: a missing or malformed
variable aborts with one message naming every offending variable at once, in alphabetical order.
Only then does the SDK check the credentials themselves, and that check stops at the first problem
it finds, naming the rule rather than the variable.

```dotenv
BUPAYMENT_APP_ID=app_replace_with_seeded_value
BUPAYMENT_KEY_ID=bup_ck_test_replace_with_seeded_value
BUPAYMENT_SECRET=bup_sec_replace_with_seeded_value
BUPAYMENT_API_BASE_URL=http://localhost:3000
```

Test credentials come from the API seed. Do not invent them and do not commit them. `.env` is
ignored; `.env.example` carries names and explanations only.

The environment is derived from the key ID by the SDK, so a Test credential cannot be pointed at
live by configuration alone.

## Request handling

| Route | Purpose |
| --- | --- |
| `GET /healthz` | Liveness and the environment derived from the key ID |
| `GET /catalogue` | The storefront: the merchant's products with their price |
| `POST /products` | Creates a local, unlinked product |
| `PUT /products/:sku/link` | Links a local product to a BuPayment product and price |
| `PUT /products/:sku/price` | Changes a price; a linked one changes in BuPayment first |
| `POST /checkout` | Sells one unit of a linked product at the displayed price |
| `POST /webhooks/bupayment` | Receives BuPayment catalogue and checkout events |

Anything else answers `404 route_not_found`. A request body is parsed as JSON up to 64kb, except the
webhook, which reads up to 256kb of raw bytes; a malformed body answers `400 request_invalid` and one
above the limit answers `413 request_invalid`. A failure
the playground does not recognize answers `500 internal_error` with a fixed message, so nothing
about the failure reaches the caller. A BuPayment failure takes its status and code from the SDK's
`publicError`: the SDK's code and status, `502` when that status is not an error status, and
`502 operation_failed` when BuPayment refused the playground's own credential, since a `401` or `403`
would tell the caller that its own request was refused. The API's message is never passed on,
because it can quote whatever the request carried.

| Route | Failure |
| --- | --- |
| `POST /products` | `422 product_invalid`, `409 product_exists` |
| `PUT /products/:sku/link` | `422 link_invalid`, `404 product_not_found` (local SKU), `422 price_not_of_product`, `422 inactive`; a BuPayment ID this application cannot see surfaces as the SDK's `404 resource_not_found` |
| `PUT /products/:sku/price` | `422 price_invalid` (an amount only; the currency never changes), `404 product_not_found`, `409 product_changed`; a failure reading or creating the BuPayment price surfaces as the SDK's status and code |
| `POST /checkout` | `422 checkout_invalid`, `404 product_not_found`, `409 not_sellable`, `409 price_unknown`, `409 order_mismatch`, `409 out_of_stock`, `409 price_changed`, `409 checkout_closed`, `503 checkout_not_configured`, `502 checkout_refused` (`202 confirming` when a checkout may have been created); any other failure creating the customer or the payment surfaces as the SDK's status and code |
| `POST /webhooks/bupayment` | `503 webhook_not_configured`, `400` with the SDK's `webhook_*` code for a refused delivery |

The merchant routes have no authorization. That is acceptable only because the playground binds to
`127.0.0.1` by default; do not expose it on another interface. They also answer
`403 host_not_allowed` unless the `Host` is `localhost`, `127.0.0.1`, `[::1]` or the configured
`HOST`, so a web page that rebinds its own name to the loopback address cannot reach them. Bound to
a wildcard address, the playground still accepts only the loopback names. The webhook is exempt: it
is reached under a public name and every delivery is signature-checked.

## Catalogue

BuPayment is the source of truth for what can be charged: it is immutable and audited, and it
decides the amount of every charge. The merchant owns everything else. The two are linked by
reference, not by copying one side into the other.

### The merchant's product

Each merchant models its products however its application needs. The playground's shape is
`sku`, `title`, `slug`, `imageUrl`, `stock` and a price, deliberately unlike BuPayment's product.
Nothing forces a merchant to mirror BuPayment's fields.

A linked product also carries `bupayment`: the `productId` and `priceId` it sells through, whether
that product and price are active and assigned to this application, the product and price
`updatedAt` last applied, and the time of the last assignment change seen for each. A product is
sellable when all four are true. Apart from the amount in `stored` mode, nothing else is copied from
BuPayment.

### Two price modes, chosen per product

How a merchant shows a price depends on how it builds its integration, so the choice is made per
product when it is linked:

| Mode | Where the price comes from | With BuPayment unreachable |
| --- | --- | --- |
| `stored` | The merchant's own copy, kept in step by reconciliation | Always shown |
| `live` | Read from BuPayment each time the storefront renders | The last value read, with its `readAt` |

An unlinked product keeps a local price and is not sellable through BuPayment.

The price of a linked product changes only in BuPayment: from the dashboard, or from the
application through the SDK, which creates a new price and returns its ID. It is never edited
locally; `PUT /products/:sku/price` does it in that order (see [Changing a price](#changing-a-price)). That rule is what makes the merchant's copy a copy: it can lag, and reconciliation pulls
the lag, but it can never be the side that changed first. A price shown late is caught at charge
time by [api#444](https://github.com/Bu-Payment/api/issues/444), so a difference does not block a
sale.

### Linking

`PUT /products/:sku/link` with `{ productId, priceId, pricing }` reads both from BuPayment and
refuses a price of another product, or an archived product or price. In `stored` mode the local price adopts
BuPayment's; in `live` mode the value read becomes the last known one.

### Reconciliation

```sh
bun run reconcile
```

The sweep pages products and prices with `active=true` and then `active=false`. The list endpoints
default to active only, so a sweep on the defaults never learns that a product was archived. The
catalogue is written once, after every page has been read; if any page fails, nothing is written and
the command exits `1`. For each linked product:

- A product or price whose `updatedAt` is older than the one applied, or unreadable, is **stale**
  and ignored. Deliveries and reads carry no ordering, and this is what makes applying them safe.
- A newer product or price is applied (**updated**): the amount is pulled into a `stored` copy or the
  last known value of a `live` one, and a product that can be sold again becomes sellable. Reading an
  unchanged `live` price only refreshes when it was read, which is not reported as a change.
- An archived product is **archived** and a product this application can no longer see is
  **withdrawn**. Both become unsellable, and are reported when that change happens.
- An archived or unassigned price is replaced by the product's default price when it is compatible,
  otherwise by the only active price of the same product with the same currency, type and recurrence
  (**repointed**). The link records those terms, so a price the application can no longer read can
  still be replaced. With no candidate, or several and no compatible default, the link keeps its IDs
  but becomes unsellable, and is reported as **price_needs_decision** on every sweep until someone
  chooses.
- Assignments are ordered by time. The sweep records when it started and leaves alone an assignment
  that a webhook recorded after that, so an older snapshot never undoes a newer event.

The sweep also lists active BuPayment products no local product links to.

Two limits are accepted for a reference consumer. The JSON store has no lock, so a request that
writes while a sweep is between loading and saving is overwritten by the sweep. And a product
reactivated between the active and inactive pass appears in neither and is withdrawn until the next
sweep.

The compiled equivalent is `bun run build && bun run start:reconcile`.

### Changing a price

`PUT /products/:sku/price` with `{ amount }`. For an unlinked product the local price changes. For
a linked product, in order:

1. The current BuPayment price is read, to keep its type and recurrence.
2. The SDK reads the product, creates the replacement, moves the product's default to it when the
   old price was the default, and then archives the old price. The move asserts the product's
   `updatedAt`, so a default another writer chose meanwhile is not overwritten; the archive sends
   the price `updatedAt` last seen, so a price changed meanwhile is not archived blindly. The
   idempotency key is derived from the SKU, the linked price, when it was linked and the amount,
   so retrying a change that failed part-way replays the first creation instead of creating a
   second price.
3. Only then does the merchant's copy and the link move to the new price.

If moving the default or the archive fails, the link still moves to the new price and the response
says `archivePending: true`. The failure is logged with the step that failed and both price IDs.
After `archive_failed` the old price stays active in BuPayment until someone archives it. After
`default_failed` the old price is still the product's default, which BuPayment refuses to archive:
move the default to the new price first, then archive the old one. If the product was linked to
another price while this ran, nothing is applied locally, the unused new price is archived, and the
request answers `409 product_changed`. If a webhook already moved the link to the new price, the
change stands.

### Webhooks

Set `BUPAYMENT_WEBHOOK_SECRET` to the `whsec_` value issued for the endpoint, and subscribe the
endpoint to the `catalogue.*` and `checkout.*` events (the checkout names carry no `.v1`). The playground has no registration script: [Testing
locally](https://github.com/Bu-Payment/api/blob/main/docs/webhooks/09-testing-locally.md) in the
[BuPayment webhook guide](https://github.com/Bu-Payment/api/blob/main/docs/webhooks/00-index.md)
registers this receiver with the SDK, triggers each catalogue event, and shows how to inspect and
redeliver the deliveries.

`POST /webhooks/bupayment` is mounted with a raw-body parser ahead of the global JSON parser,
because the signature covers `${timestamp}.${rawBody}` and re-serializing a parsed body does not
reproduce those bytes. The SDK's `webhookDelivery().secret(s).body(raw).headers(h).verify()`
checks the signature and the timestamp window and returns a typed event; a type it does not know is recorded and ignored.

- **Deduplication.** Retries are recognized by `x-webhook-id` and the same event through another
  endpoint by the envelope `id`. Both are recorded in the same write that applies the event, so an
  event is never marked as seen without being applied, or applied twice. The playground keeps these
  ids forever; a real store needs to expire them.
- **Ordering.** Product and price changes order by the resource `updatedAt`, assignment and
  unassignment by `occurredAt`. An older event is discarded.
- **Replacing a price.** When the linked price is archived or unassigned, the product and its prices
  are read from BuPayment, once per product however many SKUs link it, and the link moves under
  the same rules as the sweep. If a newer delivery changed the link during that read, the result is
  dropped. A product that BuPayment no longer lets this application read is withdrawn. If the read
  fails, the product stays unsellable until the next sweep; the delivery is still acknowledged, so
  run the sweep to recover rather than waiting for a redelivery.
- **New products.** An assignment for a BuPayment product that no local SKU links to is reported, so
  the merchant can link it.

## Checkout

`POST /checkout` with `{ orderId, sku, email }` sells one unit through the SDK's sale:

```ts
bupayment.sales
  .draft()
  .priceId(link.priceId)
  .displayedPrice(shown)
  .customerEmail(order.email)
  .reference(product.sku)
  .reservation(orderReservation(store, order.orderId, product.sku))
  .idempotencyKey(`order-${order.orderId}`)
  .charge();
```

The sale finds or creates the customer by email, asserts the displayed price, reserves and releases
the stock through the playground's hooks, and answers with a typed outcome. The payment is direct
(`POST /v1/payments`) when the provider supports it, and a hosted one-time checkout otherwise: see
[Hosted checkout](#hosted-checkout).

**The displayed price.** It is read from the merchant's catalogue and never from BuPayment: the
`stored` amount, or for a `live` product the `lastKnown` value that `GET /catalogue` records each time
it reads the price. A `live` product never displayed answers `409 price_unknown`.

**The order.** The storefront generates `orderId` once per checkout and sends the same value on every
retry of that checkout. It names the idempotency key, so a retry never charges twice, and it names
the reservation, so a retry never takes a second unit: the catalogue records which order holds which
unit, and `reserve()` answers yes without taking another when the order already holds one. An
`orderId` that already holds another product answers `409 order_mismatch`, and `reserve()` itself
never moves an order onto a second product. A paid order keeps its record, so sending it again
answers with the same payment. The playground keeps these records forever; a real store needs to
expire them.

| Outcome | Answer | Stock |
| --- | --- | --- |
| `paid` | `201` with the payment | the unit stays sold |
| `unpaid` (any status but `succeeded`) | `202` with the payment | the unit goes back |
| `price_changed` | `409 price_changed` with `shown` and `current` | the unit goes back |
| `unconfirmed` (timeout, network, 5xx) | `202` with `status: "confirming"`: retry with the same `orderId` | the unit stays held |
| `needs_reconciliation` | `202` with `status: "under_review"`, logged as an error with the request ID | the unit stays held |
| `unavailable` | `409 out_of_stock`, before any request to BuPayment | none taken |
| any other failure | the status and code of `publicError` | the unit goes back |

```json
{
  "code": "price_changed",
  "message": "The price changed since it was shown. Reload the catalogue and try again.",
  "shown": { "amount": 2750, "currency": "EUR" },
  "current": { "amount": 3000, "currency": "EUR" }
}
```

`current` is `null` when the API does not return the canonical price. A payment that settles later
does not reach the stock, since the playground does not consume payment events. There is no
quantity: the API takes one canonical price per payment.

The credential needs `payments:write`, `customers:read` and `customers:write` on top of the
catalogue capabilities.

### Hosted checkout

A provider without server-side charges (Trust My Travel, SISP) makes the sale fail with
`operation_failed` and `metadata.apiError` `provider_capability_not_supported`. The playground then
holds the unit by `orderId` and opens a one-time checkout (`POST /v1/checkouts`):

```ts
bupayment.checkout
  .sessionDraft()
  .priceId(order.priceId)
  .expectedPrice(order.shown)
  .customerEmail(order.email)
  .destination(settings.destination)
  .reference(order.orderId)
  .idempotencyKey(order.orderId)
  .provider(settings.provider)
  .create();
```

The `.provider(...)` step is added only when `BUPAYMENT_CHECKOUT_PROVIDER` is set.

`BUPAYMENT_CHECKOUT_DESTINATION` is the slug of a checkout destination of the App, configured in the
dashboard with its success and cancel URLs; without it this case answers
`503 checkout_not_configured`. A Test environment may have no default provider, so set
`BUPAYMENT_CHECKOUT_PROVIDER` (for example `trust-my-travel`). The API accepts one-time prices and
Test credentials only.

The answer is `201` with `checkoutUrl`, where the buyer pays: for Trust My Travel a page hosted by
the API that opens the provider's modal and returns to the destination's URLs, for SISP the provider's
form. The URL is a bearer credential: the playground neither logs nor stores it.

```json
{
  "orderId": "A1",
  "checkout": { "id": "chk_1", "status": "pending", "amount": 2750, "currency": "EUR", "expiresAt": "..." },
  "checkoutUrl": "https://.../public/v1/checkouts/pay/...",
  "stock": 2
}
```

The catalogue records which order each checkout belongs to. A retry with the same `orderId` goes
straight back to the checkout, without trying the sale again, and the idempotency key returns the same
checkout; once that checkout has settled, the order answers `409 checkout_closed`. A refusal
(`checkout_destination_unavailable`, `checkout_provider_unknown`, `checkout_live_not_enabled`,
`checkout_unavailable`, `checkout_provider_failed`) gives the unit back, unless the order already
has an open checkout that still holds it, and answers `502 checkout_refused` with the API code as
`reason`; a changed price answers `409 price_changed` as
above. A timeout, a network failure, an unreadable answer, a key already used with another body or another
5xx may hide a created checkout, so the unit stays held and the answer is `202 confirming`. A refusal
gives the unit back only when the order held none before the request and no checkout is recorded for
it after: a retry after an unconfirmed attempt, or a duplicate submit, never frees a unit a live
checkout may still need. The direct sale's own release waits until the playground knows it will not
fall back to the checkout, and an order that tried the checkout once never goes back to the direct
sale.

The webhook settles the unit, once per `checkoutId`:

| Event | Stock |
| --- | --- |
| `checkout.completed` | the held unit becomes a sale |
| `checkout.failed`, `checkout.expired`, `checkout.cancelled` | the held unit goes back |
| `checkout.completed` after a release | still a sale: one unit is taken again, or the delivery is logged as `oversold` when none is left |

A later event for a settled checkout is logged as `already_settled`. A checkout the playground never
recorded is adopted through the order its `reference` holds, when that order tried the checkout and
has no checkout recorded yet;
otherwise it is logged as `unknown_checkout`. One whose `reference` names another order is logged as
`reference_mismatch`. A delivery that moved no stock answers `ignored`, one that did `applied`.

## Secret handling

The confidential secret never reaches a log line, an HTTP response body, an error message, or error
metadata. The SDK wraps it so that string conversion, `JSON.stringify`, `util.inspect`, and thrown
error metadata all render `[redacted]`, and this playground never unwraps it for display. Validation
failures are reported by variable name, never by value.

A reconciliation that fails during the sweep logs the error code and status only, never the message,
because an API error body or a network error can quote whatever it was sent. One that fails before
the sweep, on configuration, logs the validation message, which names the rule and never the value.
`test/secrets.test.ts` drives the sweep through a network error, an API error body and a malformed
response that each quote the secret, a reconciliation that cannot start because the secret is
malformed, and the failure paths of the catalogue and checkout routes, and asserts the secret appears in none of
the captured log lines or responses. A live price read that fails quoting the secret is covered too.
The webhook endpoint secret is covered the same way: a valid delivery, a forged signature and a body
quoting the secret leave it in no log line or response.

## Layout

```
src/runtime       framework-agnostic: environment parsing, SDK configuration, error mapping
src/catalogue     framework-agnostic: the merchant catalogue, its link to BuPayment, reconciliation
src/checkout      framework-agnostic: selling at the displayed price, hosted checkout, settlement
src/http          the Express adapter, and the only place that imports Express
src/main.ts       boots the runtime and starts the HTTP server
src/reconcile.ts  runs one reconciliation sweep and exits
```

`src/runtime`, `src/catalogue` and `src/checkout` import nothing from Express and together form the
framework-agnostic core; they depend on each other, since the runtime context wires the catalogue
store and the reconciliation command reads the runtime configuration. A Fastify or Nest playground
reuses both unchanged and replaces only `src/http`.

## Development

```sh
bun run check
```

`bun run check` runs lint, type checking, tests with coverage, and the build.
