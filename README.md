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

The Node SDK currently exposes credential configuration only. HMAC signing and the commerce clients
are still open as [node-sdk#1](https://github.com/Bu-Payment/node-sdk/issues/1) and
[node-sdk#2](https://github.com/Bu-Payment/node-sdk/issues/2). Until those land, this playground
boots, validates its configuration, and exposes a health route. It deliberately does not fake a checkout
against surface the SDK does not have.

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

Every variable is required except `HOST` and `PORT`. Boot happens in two stages, and the error you
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

Only `GET /healthz` exists. Anything else answers `404 route_not_found`. A request body is parsed as
JSON up to 64kb; a malformed body answers `400 request_invalid` and one above the limit answers
`413 request_invalid`. A failure the playground does not recognize answers `500 internal_error` with
a fixed message, so nothing about the failure reaches the caller.

## Secret handling

The confidential secret never reaches a log line, an HTTP response body, an error message, or error
metadata. The SDK wraps it so that string conversion, `JSON.stringify`, `util.inspect`, and thrown
error metadata all render `[redacted]`, and this playground never unwraps it for display. Validation
failures are reported by variable name, never by value.

## Layout

```
src/runtime   framework-agnostic: environment parsing, SDK configuration, error mapping
src/http      the Express adapter, and the only place that imports Express
src/main.ts   boots the runtime and starts the HTTP server
```

`src/runtime` imports nothing from Express. A Fastify or Nest playground reuses it unchanged and
replaces only `src/http`.

## Development

```sh
bun run check
```

`bun run check` runs lint, type checking, tests with coverage, and the build.
