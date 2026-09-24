import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrap } from "../../src/http/bootstrap";
import { testLogger, VALID_ENV } from "../fixtures";

const running: Server[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => new Promise((done) => server.close(done))));
  process.exitCode = 0;
});

describe("bootstrap", () => {
  it("starts nothing and fails the process when the environment is unusable", () => {
    const { lines, logger } = testLogger();

    const server = bootstrap(logger, { BUPAYMENT_APP_ID: "app_playground" });

    expect(server).toBeUndefined();
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(lines[0] ?? "{}").message).toContain("BUPAYMENT_SECRET is missing");
  });

  it("fails the process when a credential is malformed", () => {
    const { lines, logger } = testLogger();

    const server = bootstrap(logger, { ...VALID_ENV, BUPAYMENT_KEY_ID: "nonsense" });

    expect(server).toBeUndefined();
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(lines[0] ?? "{}").message).toBe("Key ID format is invalid");
  });

  it("returns the running server when the environment is usable", async () => {
    const { logger } = testLogger();

    const server = bootstrap(logger, { ...VALID_ENV, PORT: "9104" });

    expect(server).toBeDefined();
    if (server) {
      running.push(server);
      await new Promise((resolve) => server.once("listening", resolve));
    }
    expect(process.exitCode).not.toBe(1);
  });
});
