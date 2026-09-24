import { describe, expect, it } from "vitest";
import { DEFAULT_HOST, DEFAULT_PORT, parseEnv } from "../../src/runtime/env";
import { ConfigurationError } from "../../src/runtime/errors";
import { FAKE_SECRET, VALID_ENV } from "../fixtures";

describe("parseEnv", () => {
  it("applies the documented host and port defaults", () => {
    const env = parseEnv(VALID_ENV);

    expect(env.HOST).toBe(DEFAULT_HOST);
    expect(env.PORT).toBe(DEFAULT_PORT);
  });

  it("reads an explicit host and port", () => {
    const env = parseEnv({ ...VALID_ENV, HOST: "0.0.0.0", PORT: "9100" });

    expect(env.HOST).toBe("0.0.0.0");
    expect(env.PORT).toBe(9100);
  });

  it("names every missing variable in one message", () => {
    const call = () => parseEnv({ BUPAYMENT_APP_ID: "app_playground" });

    expect(call).toThrow(ConfigurationError);
    expect(call).toThrow(/BUPAYMENT_API_BASE_URL is missing/);
    expect(call).toThrow(/BUPAYMENT_KEY_ID is missing/);
    expect(call).toThrow(/BUPAYMENT_SECRET is missing/);
  });

  it("separates a blank variable from a malformed one", () => {
    const call = () => parseEnv({ ...VALID_ENV, BUPAYMENT_APP_ID: "   ", PORT: "not-a-port" });

    expect(call).toThrow(/BUPAYMENT_APP_ID is missing/);
    expect(call).toThrow(/PORT is invalid/);
  });

  it("never repeats a rejected value, so a malformed secret cannot leak", () => {
    try {
      parseEnv({ ...VALID_ENV, BUPAYMENT_SECRET: " " });
      expect.unreachable("parseEnv should have rejected the blank secret");
    } catch (error) {
      expect(String(error)).not.toContain(FAKE_SECRET);
      expect(String(error)).toContain("BUPAYMENT_SECRET is missing");
    }
  });
});
