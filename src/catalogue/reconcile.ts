import type { CatalogueClient, Price, Product } from "@bu-payment/node-sdk";
import { type ApplyOutcome, applyPrice, applyProduct, type CatalogueMirror } from "./mirror";
import type { CatalogueStore } from "./store";

export type ChangeKind = Exclude<ApplyOutcome, "unchanged"> | "withdrawn";

export interface CatalogueChange {
  resource: "product" | "price";
  id: string;
  change: ChangeKind;
}

export interface ReconcileReport {
  observed: { products: number; prices: number };
  unchanged: number;
  changes: CatalogueChange[];
}

export async function reconcileCatalogue(
  catalogue: CatalogueClient,
  store: CatalogueStore,
  now: () => Date = () => new Date(),
): Promise<ReconcileReport> {
  const products = await collect([
    catalogue.products().active(true).all(),
    catalogue.products().active(false).all(),
  ]);
  const prices = await collect([
    catalogue.prices().active(true).all(),
    catalogue.prices().active(false).all(),
  ]);
  const syncedAt = now().toISOString();
  const mirror = store.load();
  const report: ReconcileReport = {
    observed: { products: products.length, prices: prices.length },
    unchanged: 0,
    changes: [],
  };
  const record = (resource: CatalogueChange["resource"], id: string, outcome: ApplyOutcome) => {
    if (outcome === "unchanged") {
      report.unchanged += 1;
      return;
    }
    report.changes.push({ resource, id, change: outcome });
  };
  for (const product of products) {
    record("product", product.id, applyProduct(mirror, product));
  }
  for (const price of prices) {
    record("price", price.id, applyPrice(mirror, price, syncedAt));
  }
  report.changes.push(...withdraw(mirror, products, prices));
  store.save(mirror);
  return report;
}

async function collect<T>(walks: AsyncGenerator<T, void, undefined>[]): Promise<T[]> {
  const items: T[] = [];
  for (const walk of walks) {
    for await (const item of walk) {
      items.push(item);
    }
  }
  return items;
}

function withdraw(
  mirror: CatalogueMirror,
  products: readonly Product[],
  prices: readonly Price[],
): CatalogueChange[] {
  const seenProducts = new Set(products.map((product) => product.id));
  const seenPrices = new Set(prices.map((price) => price.id));
  const changes: CatalogueChange[] = [];
  for (const product of Object.values(mirror.products)) {
    if (product.active && !seenProducts.has(product.bupaymentProductId)) {
      product.active = false;
      changes.push({ resource: "product", id: product.bupaymentProductId, change: "withdrawn" });
    }
  }
  for (const price of Object.values(mirror.prices)) {
    if (price.active && !seenPrices.has(price.bupaymentPriceId)) {
      price.active = false;
      changes.push({ resource: "price", id: price.bupaymentPriceId, change: "withdrawn" });
    }
  }
  return changes;
}
