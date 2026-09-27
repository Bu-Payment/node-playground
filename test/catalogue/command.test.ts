import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runReconciliation } from "../../src/catalogue/command";
import { emptyCatalogue, putProduct } from "../../src/catalogue/merchant";
import { fileStore } from "../../src/catalogue/store";
import { fakeCatalogueApi, price, product, unreachableApi } from "../fakes/catalogue-api";
import { link, merchantProduct } from "../fakes/merchant";
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
  it("writes the reconciled catalogue to the configured store and reports each change", async () => {
    const path = storePath();
    const seeded = emptyCatalogue();
    putProduct(seeded, merchantProduct({ sku: "TICKET", bupayment: link() }));
    fileStore(path).save(seeded);
    const { lines, logger } = testLogger();
    const api = fakeCatalogueApi({
      products: [product({ id: "prod_1" }), product({ id: "prod_new" })],
      prices: [
        price({
          id: "price_1",
          productId: "prod_1",
          unitAmount: 1800,
          updatedAt: "2026-09-20T00:00:00Z",
        }),
      ],
    });

    const code = await runReconciliation(
      logger,
      { ...VALID_ENV, CATALOGUE_STORE_PATH: path },
      { fetch: api.fetch },
    );

    expect(code).toBe(0);
    expect(fileStore(path).load().products.TICKET?.pricing).toEqual({
      mode: "stored",
      amount: 1800,
      currency: "EUR",
    });
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { level: "info", message: "Catalogue link reconciled", sku: "TICKET", outcome: "updated" },
      {
        level: "info",
        message: "BuPayment product not linked to any local product",
        productId: "prod_new",
      },
      {
        level: "info",
        message: "Catalogue reconciled",
        products: 2,
        prices: 1,
        changed: 1,
        inSync: 0,
        unlinked: 1,
      },
    ]);
  });

  it("fails without writing when BuPayment is unreachable", async () => {
    const path = storePath();
    const seeded = emptyCatalogue();
    putProduct(seeded, merchantProduct({ sku: "KEPT", bupayment: link() }));
    fileStore(path).save(seeded);
    const before = readFileSync(path, "utf8");
    const { lines, logger } = testLogger();

    const code = await runReconciliation(
      logger,
      { ...VALID_ENV, CATALOGUE_STORE_PATH: path },
      { fetch: unreachableApi() },
    );

    expect(code).toBe(1);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(JSON.parse(lines[0] ?? "{}")).toEqual({
      level: "error",
      message: "Catalogue reconciliation failed, local catalogue left untouched",
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
