import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { createContext } from "../../src/runtime/context";
import { parseEnv } from "../../src/runtime/env";
import { createLogger } from "../../src/runtime/logger";
import { FAKE_SECRET, testContext, VALID_ENV } from "../fixtures";

describe("createContext", () => {
  it("derives the environment from the key ID", () => {
    const { context } = testContext();

    expect(context.client.environment).toBe("test");
    expect(context.client.applicationId).toBe("app_playground");
    expect(context.client.apiBaseUrl.toString()).toBe("http://localhost:3000/");
  });

  it("carries the listening address", () => {
    const { context } = testContext({ HOST: "0.0.0.0", PORT: "9100" });

    expect(context.server).toEqual({ host: "0.0.0.0", port: 9100 });
  });

  it("rejects a credential whose key ID does not match the declared environment", () => {
    const call = () =>
      createContext(parseEnv({ ...VALID_ENV, BUPAYMENT_KEY_ID: "nonsense" }), createLogger());

    expect(call).toThrow(/Key ID format is invalid/);
  });

  it("refuses a plain HTTP API base URL that is not loopback", () => {
    const call = () =>
      createContext(
        parseEnv({ ...VALID_ENV, BUPAYMENT_API_BASE_URL: "http://example.com" }),
        createLogger(),
      );

    expect(call).toThrow(/API base URL must use HTTPS or loopback HTTP/);
  });

  it("keeps the secret redacted under serialization and inspection", () => {
    const { context } = testContext();

    expect(JSON.stringify(context.client)).not.toContain(FAKE_SECRET);
    expect(inspect(context.client, { depth: null })).not.toContain(FAKE_SECRET);
    expect(String(context.client.secret)).toBe("[redacted]");
  });
});
