import type { CatalogueClient } from "@bu-payment/node-sdk";
import { indexRemote, type LinkOutcome, syncLink } from "./link-sync";
import { putProduct } from "./merchant";
import type { CatalogueStore } from "./store";

export interface LinkChange {
  sku: string;
  outcome: Exclude<LinkOutcome, "in_sync">;
}

export interface ReconcileReport {
  observed: { products: number; prices: number };
  inSync: number;
  changes: LinkChange[];
  unlinked: string[];
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
  const remote = indexRemote(products, prices);
  const readAt = now().toISOString();
  const local = store.load();
  const report: ReconcileReport = {
    observed: { products: products.length, prices: prices.length },
    inSync: 0,
    changes: [],
    unlinked: [],
  };
  const linked = new Set<string>();
  for (const product of Object.values(local.products)) {
    if (product.bupayment === null) {
      continue;
    }
    linked.add(product.bupayment.productId);
    const result = syncLink(product, remote, readAt);
    putProduct(local, result.product);
    if (result.outcome === "in_sync") {
      report.inSync += 1;
      continue;
    }
    report.changes.push({ sku: product.sku, outcome: result.outcome });
  }
  report.unlinked = [...remote.products.values()]
    .filter((product) => product.active && !linked.has(product.id))
    .map((product) => product.id);
  store.save(local);
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
