import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runReconciliation } from "../../src/catalogue/command";
import { fileStore } from "../../src/catalogue/store";
import { fakeCatalogueApi, product, unreachableApi } from "../fakes/catalogue-api";
import { testLogger, VALID_ENV } from "../fixtures";

const directories: string[] = [];

function storePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "playground-reconcile-"));
  directories.push(directory);
  return join(directory, "catalogue.json");
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("runReconciliation", () => {
  it("writes the swept catalogue to the configured store and reports each change", async () => {
    const path = storePath();
    const { lines, logger } = testLogger();
    const api = fakeCatalogueApi({ products: [product({ id: "prod_1" })] });

    const code = await runReconciliation(
      logger,
      { ...VALID_ENV, CATALOGUE_STORE_PATH: path },
      { fetch: api.fetch },
    );

    expect(code).toBe(0);
    expect(Object.keys(fileStore(path).load().products)).toEqual(["prod_1"]);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        level: "info",
        message: "Catalogue drift repaired",
        resource: "product",
        id: "prod_1",
        change: "created",
      },
      {
        level: "info",
        message: "Catalogue reconciled",
        products: 1,
        prices: 0,
        changed: 1,
        unchanged: 0,
      },
    ]);
  });

  it("fails without writing when BuPayment is unreachable", async () => {
    const path = storePath();
    const { lines, logger } = testLogger();

    const code = await runReconciliation(
      logger,
      { ...VALID_ENV, CATALOGUE_STORE_PATH: path },
      { fetch: unreachableApi() },
    );

    expect(code).toBe(1);
    expect(fileStore(path).load().products).toEqual({});
    expect(JSON.parse(lines[0] ?? "{}")).toEqual({
      level: "error",
      message: "Catalogue reconciliation failed, local mirror left untouched",
      code: "network_unavailable",
      status: 502,
    });
  });

  it("fails before any request when the environment is unusable", async () => {
    const { lines, logger } = testLogger();

    const code = await runReconciliation(logger, { BUPAYMENT_APP_ID: "app_playground" });

    expect(code).toBe(1);
    expect(JSON.parse(lines[0] ?? "{}").message).toContain("BUPAYMENT_SECRET is missing");
  });
});
