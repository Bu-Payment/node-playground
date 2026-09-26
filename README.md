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
BuPayment product and price by reference. See [Catalogue](#catalogue).

Three parts wait on work in other repositories. They are left out rather than simulated:

- **Receiving catalogue webhooks** waits on typed events in the SDK
  ([node-sdk#21](https://github.com/Bu-Payment/node-sdk/issues/21)).
- **Changing the price of a linked product** waits on catalogue writes in the SDK
  ([node-sdk#18](https://github.com/Bu-Payment/node-sdk/issues/18)).
- **Handling a `409 price_changed` at checkout** waits on the charge-time price assertion
  ([api#444](https://github.com/Bu-Payment/api/issues/444)).

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

Every variable is required except `HOST`, `PORT` and `CATALOGUE_STORE_PATH`. Boot happens in two stages, and the error you
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

Anything else answers `404 route_not_found`. A request body is parsed as JSON up to 64kb; a malformed
body answers `400 request_invalid` and one above the limit answers `413 request_invalid`. A failure
the playground does not recognize answers `500 internal_error` with a fixed message, so nothing
about the failure reaches the caller.

| Route | Failure |
| --- | --- |
| `POST /products` | `422 product_invalid`, `409 product_exists` |
| `PUT /products/:sku/link` | `422 link_invalid`, `404 product_not_found` (local SKU), `422 price_not_of_product`, `422 inactive`; a BuPayment ID this application cannot see surfaces as the SDK's `404 resource_not_found` |

The write routes have no authorization. That is acceptable only because the playground binds to
`127.0.0.1` by default; do not expose it on another interface.

## Catalogue

BuPayment is the source of truth for what can be charged: it is immutable and audited, and it
decides the amount of every charge. The merchant owns everything else. The two are linked by
reference, not by copying one side into the other.

### The merchant's product

Each merchant models its products however its application needs. The playground's shape is
`sku`, `title`, `slug`, `imageUrl`, `stock` and a price, deliberately unlike BuPayment's product.
Nothing forces a merchant to mirror BuPayment's fields.

A linked product also carries `bupayment`: the `productId` and `priceId` it sells through, whether
BuPayment can currently sell it (`sellable`), and the product and price `updatedAt` last applied.
Apart from the amount in `stored` mode, nothing else is copied from BuPayment.

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
locally. That rule is what makes the merchant's copy a copy: it can lag, and reconciliation pulls
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
- A newer product or price is applied (**updated**): the amount is pulled into a `stored` copy, and a
  product that can be sold again becomes sellable. A `live` product only refreshes its last known
  value, which is not reported as a change.
- An archived product is **archived** and a product this application can no longer see is
  **withdrawn**. Both become unsellable, and are reported when the product stops being sellable.
- An archived price is replaced by the only active price of the same product with the same currency,
  type and recurrence (**repointed**). With none or several, or when the linked price is no longer
  visible at all, the link keeps its IDs but becomes unsellable, and is reported as
  **price_needs_decision** on every sweep until someone chooses.

The sweep also lists active BuPayment products no local product links to. The product's
`defaultPriceId` will become the first choice for a replacement once product reads carry it
([api#446](https://github.com/Bu-Payment/api/issues/446)).

Two limits are accepted for a reference consumer. The JSON store has no lock, so a request that
writes while a sweep is between loading and saving is overwritten by the sweep. And a product
reactivated between the active and inactive pass appears in neither and is withdrawn until the next
sweep.

The compiled equivalent is `bun run build && bun run start:reconcile`.

### Not yet here

`POST /webhooks/bupayment` will be mounted with a raw-body parser ahead of the global JSON parser,
because the signature covers `${timestamp}.${rawBody}` and re-serializing a parsed body does not
reproduce those bytes. Deliveries will be deduplicated on `x-webhook-id` and events on the envelope
`id`, and applied through the same rules as the sweep. Assignment events order by `occurredAt`
rather than `updatedAt`.

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
malformed, and the failure paths of the catalogue routes, and asserts the secret appears in none of
the captured log lines or responses. A live price read that fails quoting the secret is covered too.
The webhook endpoint secret joins that test when the webhook route lands; until then the playground
does not read one.

## Layout

```
src/runtime       framework-agnostic: environment parsing, SDK configuration, error mapping
src/catalogue     framework-agnostic: the merchant catalogue, its link to BuPayment, reconciliation
src/http          the Express adapter, and the only place that imports Express
src/main.ts       boots the runtime and starts the HTTP server
src/reconcile.ts  runs one reconciliation sweep and exits
```

`src/runtime` and `src/catalogue` import nothing from Express and together form the
framework-agnostic core; they depend on each other, since the runtime context wires the catalogue
store and the reconciliation command reads the runtime configuration. A Fastify or Nest playground
reuses both unchanged and replaces only `src/http`.

## Development

```sh
bun run check
```

`bun run check` runs lint, type checking, tests with coverage, and the build.
