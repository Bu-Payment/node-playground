import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  emptyCatalogue,
  findProduct,
  type MerchantCatalogue,
  MerchantCatalogueSchema,
  type MerchantProduct,
  putProduct,
} from "./merchant";

export interface CatalogueStore {
  load(): MerchantCatalogue;
  save(catalogue: MerchantCatalogue): void;
}

export function updateProduct(
  store: CatalogueStore,
  sku: string,
  change: (current: MerchantProduct) => MerchantProduct | undefined,
): MerchantProduct | undefined {
  const catalogue = store.load();
  const current = findProduct(catalogue, sku);
  const next = current === undefined ? undefined : change(current);
  if (next === undefined) {
    return undefined;
  }
  putProduct(catalogue, next);
  store.save(catalogue);
  return next;
}

export function memoryStore(initial: MerchantCatalogue = emptyCatalogue()): CatalogueStore {
  let current = structuredClone(initial);
  return {
    load: () => structuredClone(current),
    save: (catalogue) => {
      current = structuredClone(catalogue);
    },
  };
}

export function fileStore(path: string): CatalogueStore {
  return {
    load: () => {
      const text = readIfPresent(path);
      return text === undefined
        ? emptyCatalogue()
        : MerchantCatalogueSchema.parse(JSON.parse(text));
    },
    save: (catalogue) => {
      mkdirSync(dirname(path), { recursive: true });
      const pending = `${path}.${process.pid}.tmp`;
      writeFileSync(pending, `${JSON.stringify(catalogue, null, 2)}\n`);
      renameSync(pending, path);
    },
  };
}

function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}
