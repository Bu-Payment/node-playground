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

The Node SDK signs every request and carries the app-scoped commerce clients. The playground uses
the catalogue client to keep a local mirror of the products and prices this application can see,
and serves its storefront from that mirror alone. See [Catalogue synchronization](#catalogue-synchronization).

Two parts of the two-way flow are deliberately absent, because the platform does not support them
yet and faking them would prove nothing:

- Receiving catalogue webhooks waits for signature verification in the SDK
  ([node-sdk#7](https://github.com/Bu-Payment/node-sdk/issues/7)) and for the API to emit catalogue
  events at all ([api#430](https://github.com/Bu-Payment/api/issues/430)).
- Creating a product here and pushing it to BuPayment waits for a machine catalogue write surface
  ([api#431](https://github.com/Bu-Payment/api/issues/431)) and a per-tenant natural key for products
  ([api#432](https://github.com/Bu-Payment/api/issues/432)), without which a retried create
  duplicates the product.

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
| `GET /catalogue` | The storefront, read from the local mirror only |
| `PUT /catalogue/products/:productId/image` | Sets the local-only image of a mirrored product |

Anything else answers `404 route_not_found`. A request body is parsed as JSON up to 64kb; a malformed
body answers `400 request_invalid` and one above the limit answers `413 request_invalid`. A failure
the playground does not recognize answers `500 internal_error` with a fixed message, so nothing
about the failure reaches the caller.

## Catalogue synchronization

BuPayment owns what is chargeable: name, description, amount, currency, recurrence, and whether a
product or price is active. The merchant application owns everything a storefront needs that the
canonical catalogue has no field for. Here that is one field, `imageUrl`, which is enough to make
the point: the local product and the BuPayment product are two entities linked by
`bupaymentProductId`, not one entity copied twice.

### The mirror

`var/catalogue.json` (`CATALOGUE_STORE_PATH`) holds one row per product and per price. It is a JSON
file because this is a reference consumer; any store that holds rows will do.

Each product keeps `bupaymentProductId`, `name`, `description`, `active`, the `updatedAt` BuPayment
reported, and the local `imageUrl`. Each price keeps `bupaymentPriceId`, `bupaymentProductId`,
`cachedUnitAmount`, `cachedCurrency`, `type`, `interval`, `intervalCount`, `active`, `updatedAt` and
`syncedAt`.

The amount is named `cachedUnitAmount` on purpose. `GET /catalogue` returns it under `display`,
next to the `syncedAt` it was observed at, and nothing in the playground ever sends it back to
BuPayment. A charge references the price by ID and BuPayment decides the amount; the SDK's payment
builder does not even offer `amount()` once `priceId()` is set. A cached amount used for charging is
how a storefront shows 1500 and charges 1800 without anyone noticing.

### Reading with BuPayment unreachable

`GET /catalogue` never calls the API. During a BuPayment incident the storefront keeps rendering
from the mirror; only checkout, which must reach BuPayment, fails. That is the right way round:
degrade the sale, not the site.

### Reconciliation

```sh
bun run reconcile
```

The sweep pages the whole catalogue through the SDK and writes the mirror once, at the end. It asks
for `active=true` and then `active=false`, for products and for prices. Both passes matter: the
list endpoints filter `active=true` by default, so a sweep on the defaults never sees an archived
product, and the storefront keeps selling it.

Every row is applied through the same rule:

- A row the mirror does not have is **created**.
- A row whose `updatedAt` is older than the stored one is **stale** and discarded. The mirror keeps
  what it already knew. This is what makes an out-of-order or replayed update harmless, and it is the
  rule the webhook consumer will reuse, because deliveries are at-least-once with no ordering.
- A row with the same or a newer `updatedAt` overwrites the BuPayment-owned fields and is reported
  **updated** when anything differed, which is how drift gets repaired. `imageUrl` is never touched.
- A row the mirror holds as active but that neither pass returned is **withdrawn**: deactivated
  locally, because this application can no longer see it at all (unassigned in the dashboard, for
  instance).

Each change is logged on its own line, followed by a summary. If any page fails, nothing is written
and the command exits `1`; a half-applied sweep would withdraw everything it had not reached yet.

The compiled equivalent is `bun run build && bun run start:reconcile`.

### When the two sides disagree

| Situation | Outcome |
| --- | --- |
| Amount changed in BuPayment | The next sweep updates `cachedUnitAmount`; charges were already correct because they reference the price |
| Product archived in BuPayment | The inactive pass sees it and the storefront stops listing it |
| Product unassigned from this application | Neither pass returns it, so it is withdrawn locally |
| Local image changed | BuPayment never learns about it; sweeps leave it alone |
| Local row newer than the swept row | The sweep reports it stale and keeps the local row |

### Not yet here

`POST /webhooks/bupayment` will be mounted with a raw-body parser ahead of the global JSON parser.
The signature covers `${timestamp}.${rawBody}`, and re-serializing a parsed body does not reproduce
those bytes. Deliveries will be deduplicated by `x-webhook-id` and applied through the same rule as
the sweep. It lands once [node-sdk#7](https://github.com/Bu-Payment/node-sdk/issues/7) ships the
verifier and [api#430](https://github.com/Bu-Payment/api/issues/430) emits something to verify.

`POST /products` lands once [api#431](https://github.com/Bu-Payment/api/issues/431) and
[api#432](https://github.com/Bu-Payment/api/issues/432) do.

## Secret handling

The confidential secret never reaches a log line, an HTTP response body, an error message, or error
metadata. The SDK wraps it so that string conversion, `JSON.stringify`, `util.inspect`, and thrown
error metadata all render `[redacted]`, and this playground never unwraps it for display. Validation
failures are reported by variable name, never by value.

A reconciliation that fails during the sweep logs the error code and status only, never the message,
because an API error body or a network error can quote whatever it was sent. One that fails before
the sweep, on configuration, logs the validation message, which names the rule and never the value.
`test/secrets.test.ts` drives the sweep, a startup failure on a malformed secret and every catalogue
route, including failures that quote the secret, and asserts it appears in none of the captured log
lines or responses. The webhook endpoint secret joins that test when the webhook route lands; until
then the playground does not read one.

## Layout

```
src/runtime       framework-agnostic: environment parsing, SDK configuration, error mapping
src/catalogue     framework-agnostic: the mirror, its store, the storefront view, reconciliation
src/http          the Express adapter, and the only place that imports Express
src/main.ts       boots the runtime and starts the HTTP server
src/reconcile.ts  runs one reconciliation sweep and exits
```

`src/runtime` and `src/catalogue` import nothing from Express. A Fastify or Nest playground reuses it unchanged and
replaces only `src/http`.

## Development

```sh
bun run check
```

`bun run check` runs lint, type checking, tests with coverage, and the build.
