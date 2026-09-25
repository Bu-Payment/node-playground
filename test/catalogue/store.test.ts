import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyProduct, emptyMirror } from "../../src/catalogue/mirror";
import { fileStore, memoryStore } from "../../src/catalogue/store";
import { product } from "../fakes/catalogue-api";

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
    expect(fileStore(join(scratch(), "missing", "catalogue.json")).load()).toEqual(emptyMirror());
  });

  it("round-trips a mirror through disk, creating the directory", () => {
    const path = join(scratch(), "nested", "catalogue.json");
    const mirror = emptyMirror();
    applyProduct(mirror, product({ id: "prod_1" }));

    fileStore(path).save(mirror);

    expect(fileStore(path).load()).toEqual(mirror);
  });

  it("refuses a file that does not hold a mirror", () => {
    const path = join(scratch(), "catalogue.json");
    writeFileSync(path, JSON.stringify({ products: { prod_1: { name: 1 } }, prices: {} }));

    expect(() => fileStore(path).load()).toThrow();
  });

  it("surfaces a read failure other than a missing file", () => {
    expect(() => fileStore(scratch()).load()).toThrow(/EISDIR/);
  });
});

describe("memoryStore", () => {
  it("hands out copies, so an unsaved edit does not leak into the store", () => {
    const store = memoryStore();
    const mirror = store.load();
    applyProduct(mirror, product({ id: "prod_1" }));

    expect(store.load()).toEqual(emptyMirror());
    store.save(mirror);
    expect(Object.keys(store.load().products)).toEqual(["prod_1"]);
  });
});
