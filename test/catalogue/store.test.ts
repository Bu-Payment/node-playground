import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyCatalogue, putProduct } from "../../src/catalogue/merchant";
import { fileStore, memoryStore, updateProduct } from "../../src/catalogue/store";
import { link, merchantProduct } from "../fakes/merchant";

const directories: string[] = [];

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "playground-store-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("fileStore", () => {
  it("starts empty when nothing has been written yet", () => {
    expect(fileStore(join(scratch(), "missing", "catalogue.json")).load()).toEqual(
      emptyCatalogue(),
    );
  });

  it("round-trips stored and live products through disk", () => {
    const path = join(scratch(), "nested", "catalogue.json");
    const catalogue = emptyCatalogue();
    putProduct(catalogue, merchantProduct({ sku: "TICKET" }));
    putProduct(
      catalogue,
      merchantProduct({
        sku: "PASS",
        pricing: {
          mode: "live",
          lastKnown: { amount: 900, currency: "EUR", readAt: "2026-09-01" },
        },
        bupayment: link(),
      }),
    );

    fileStore(path).save(catalogue);

    expect(fileStore(path).load()).toEqual(catalogue);
  });

  it("refuses a file that does not hold a merchant catalogue", () => {
    const path = join(scratch(), "catalogue.json");
    writeFileSync(path, JSON.stringify({ products: { TICKET: { sku: 1 } } }));

    expect(() => fileStore(path).load()).toThrow();
  });

  it("surfaces a read failure other than a missing file", () => {
    expect(() => fileStore(scratch()).load()).toThrow(/EISDIR/);
  });
});

describe("memoryStore", () => {
  it("hands out copies, so an unsaved edit does not leak into the store", () => {
    const store = memoryStore();
    const catalogue = store.load();
    putProduct(catalogue, merchantProduct({ sku: "TICKET" }));

    expect(store.load()).toEqual(emptyCatalogue());
    store.save(catalogue);
    expect(Object.keys(store.load().products)).toEqual(["TICKET"]);
  });
});

describe("updateProduct", () => {
  function storeWithTicket() {
    const catalogue = emptyCatalogue();
    putProduct(catalogue, merchantProduct({ sku: "TICKET", stock: 1 }));
    return memoryStore(catalogue);
  }

  it("changes the current row and saves it", () => {
    const store = storeWithTicket();

    const updated = updateProduct(store, "TICKET", (current) => ({
      ...current,
      stock: current.stock + 1,
    }));

    expect(updated?.stock).toBe(2);
    expect(store.load().products.TICKET?.stock).toBe(2);
  });

  it("does nothing for an unknown SKU", () => {
    const store = storeWithTicket();

    expect(updateProduct(store, "__proto__", (current) => current)).toBeUndefined();
    expect(Object.keys(store.load().products)).toEqual(["TICKET"]);
  });

  it("saves nothing when the change declines", () => {
    const store = storeWithTicket();
    const before = store.load();

    expect(updateProduct(store, "TICKET", () => undefined)).toBeUndefined();
    expect(store.load()).toEqual(before);
  });
});
