import { createContext } from "../src/runtime/context";
import type { EnvSource } from "../src/runtime/env";
import { parseEnv } from "../src/runtime/env";
import { createLogger } from "../src/runtime/logger";

export const FAKE_SECRET = "bup_sec_DRQbIikwNz5FTFNaYWhvdn2Ei5KZoKeutbzDytHY3-Y";

export const VALID_ENV: EnvSource = {
  BUPAYMENT_APP_ID: "app_playground",
  BUPAYMENT_KEY_ID: "bup_ck_test_playground",
  BUPAYMENT_SECRET: FAKE_SECRET,
  BUPAYMENT_API_BASE_URL: "http://localhost:3000",
};

export function testLogger() {
  const lines: string[] = [];
  return { lines, logger: createLogger((line) => lines.push(line)) };
}

export function testContext(overrides: EnvSource = {}) {
  const { lines, logger } = testLogger();
  return { lines, context: createContext(parseEnv({ ...VALID_ENV, ...overrides }), logger) };
}
