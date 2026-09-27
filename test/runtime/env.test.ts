import { describe, expect, it } from "vitest";
import {
  DEFAULT_CATALOGUE_STORE_PATH,
  DEFAULT_HOST,
  DEFAULT_PORT,
  parseEnv,
} from "../../src/runtime/env";
import { ConfigurationError } from "../../src/runtime/errors";
import { WEBHOOK_SECRET } from "../fakes/webhook";
import { FAKE_SECRET, VALID_ENV } from "../fixtures";

describe("parseEnv", () => {
  it("applies the documented host and port defaults", () => {
    const env = parseEnv(VALID_ENV);

    expect(env.HOST).toBe(DEFAULT_HOST);
    expect(env.PORT).toBe(DEFAULT_PORT);
    expect(env.CATALOGUE_STORE_PATH).toBe(DEFAULT_CATALOGUE_STORE_PATH);
  });

  it("reads an explicit catalogue store path", () => {
    expect(parseEnv({ ...VALID_ENV, CATALOGUE_STORE_PATH: "/srv/mirror.json" })).toMatchObject({
      CATALOGUE_STORE_PATH: "/srv/mirror.json",
    });
  });

  it("reads an explicit host and port", () => {
    const env = parseEnv({ ...VALID_ENV, HOST: "0.0.0.0", PORT: "9100" });

    expect(env.HOST).toBe("0.0.0.0");
    expect(env.PORT).toBe(9100);
  });

  it.each(["0", "65536", "9003.5", "-1"])("rejects %s as a port", (port) => {
    expect(() => parseEnv({ ...VALID_ENV, PORT: port })).toThrow(/PORT is invalid/);
  });

  it("names every missing variable once, in alphabetical order", () => {
    const call = () => parseEnv({ BUPAYMENT_APP_ID: "app_playground" });

    expect(call).toThrow(ConfigurationError);
    expect(call).toThrow(
      "Environment is not usable: BUPAYMENT_API_BASE_URL is missing; " +
        "BUPAYMENT_KEY_ID is missing; BUPAYMENT_SECRET is missing",
    );
  });

  it("separates a blank variable from a malformed one", () => {
    const call = () => parseEnv({ ...VALID_ENV, BUPAYMENT_APP_ID: "   ", PORT: "not-a-port" });

    expect(call).toThrow(/BUPAYMENT_APP_ID is missing/);
    expect(call).toThrow(/PORT is invalid/);
  });

  it("treats a blank optional variable as absent", () => {
    const env = parseEnv({
      ...VALID_ENV,
      HOST: "",
      PORT: " ",
      CATALOGUE_STORE_PATH: "",
      BUPAYMENT_WEBHOOK_SECRET: "",
    });

    expect(env).toMatchObject({
      HOST: DEFAULT_HOST,
      PORT: DEFAULT_PORT,
      CATALOGUE_STORE_PATH: DEFAULT_CATALOGUE_STORE_PATH,
    });
    expect(env.BUPAYMENT_WEBHOOK_SECRET).toBeUndefined();
  });

  it("treats the webhook endpoint secret as optional", () => {
    expect(parseEnv(VALID_ENV).BUPAYMENT_WEBHOOK_SECRET).toBeUndefined();
    expect(
      parseEnv({ ...VALID_ENV, BUPAYMENT_WEBHOOK_SECRET: WEBHOOK_SECRET }).BUPAYMENT_WEBHOOK_SECRET,
    ).toBe(WEBHOOK_SECRET);
  });

  it("refuses a malformed webhook endpoint secret without repeating it", () => {
    const malformed = `${WEBHOOK_SECRET.slice(0, 20)}`;

    expect(() => parseEnv({ ...VALID_ENV, BUPAYMENT_WEBHOOK_SECRET: malformed })).toThrow(
      "Environment is not usable: BUPAYMENT_WEBHOOK_SECRET is invalid",
    );
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
