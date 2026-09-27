import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { emptyCatalogue } from "../../src/catalogue/merchant";
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

  it("builds an SDK client for the same application and environment", () => {
    const { context } = testContext();

    expect(context.bupayment.applicationId).toBe("app_playground");
    expect(context.bupayment.environment).toBe("test");
  });

  it("keeps the merchant catalogue at the configured path", () => {
    const directory = mkdtempSync(join(tmpdir(), "playground-context-"));
    const path = join(directory, "catalogue.json");
    const context = createContext(
      parseEnv({ ...VALID_ENV, CATALOGUE_STORE_PATH: path }),
      createLogger(),
    );

    context.catalogue.save(emptyCatalogue());

    expect(existsSync(path)).toBe(true);
    rmSync(directory, { recursive: true, force: true });
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
