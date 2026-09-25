import type { Price, Product } from "@bu-payment/node-sdk";
import { z } from "zod";

const MirroredProductSchema = z.object({
  bupaymentProductId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  active: z.boolean(),
  updatedAt: z.string(),
  imageUrl: z.string().nullable(),
});

const MirroredPriceSchema = z.object({
  bupaymentPriceId: z.string(),
  bupaymentProductId: z.string(),
  cachedUnitAmount: z.number(),
  cachedCurrency: z.string(),
  type: z.enum(["one_time", "recurring"]),
  interval: z.enum(["day", "week", "month", "year"]).nullable(),
  intervalCount: z.number().nullable(),
  active: z.boolean(),
  updatedAt: z.string(),
  syncedAt: z.string(),
});

export const CatalogueMirrorSchema = z.object({
  products: z.record(z.string(), MirroredProductSchema),
  prices: z.record(z.string(), MirroredPriceSchema),
});

export type MirroredProduct = z.infer<typeof MirroredProductSchema>;
export type MirroredPrice = z.infer<typeof MirroredPriceSchema>;
export type CatalogueMirror = z.infer<typeof CatalogueMirrorSchema>;

export type ApplyOutcome = "created" | "updated" | "unchanged" | "stale";

export function emptyMirror(): CatalogueMirror {
  return { products: {}, prices: {} };
}

export function applyProduct(mirror: CatalogueMirror, remote: Product): ApplyOutcome {
  const stored = mirror.products[remote.id];
  if (stored !== undefined && isOlder(remote.updatedAt, stored.updatedAt)) {
    return "stale";
  }
  const next: MirroredProduct = {
    bupaymentProductId: remote.id,
    name: remote.name,
    description: remote.description,
    active: remote.active,
    updatedAt: remote.updatedAt,
    imageUrl: stored?.imageUrl ?? null,
  };
  mirror.products[remote.id] = next;
  return outcomeOf(stored, next);
}

export function applyPrice(mirror: CatalogueMirror, remote: Price, syncedAt: string): ApplyOutcome {
  const stored = mirror.prices[remote.id];
  if (stored !== undefined && isOlder(remote.updatedAt, stored.updatedAt)) {
    return "stale";
  }
  const next: MirroredPrice = {
    bupaymentPriceId: remote.id,
    bupaymentProductId: remote.productId,
    cachedUnitAmount: remote.unitAmount,
    cachedCurrency: remote.currency,
    type: remote.type,
    interval: remote.recurring?.interval ?? null,
    intervalCount: remote.recurring?.intervalCount ?? null,
    active: remote.active,
    updatedAt: remote.updatedAt,
    syncedAt,
  };
  mirror.prices[remote.id] = next;
  return outcomeOf(stored && { ...stored, syncedAt }, next);
}

function isOlder(candidate: string, stored: string): boolean {
  return Date.parse(candidate) < Date.parse(stored);
}

function outcomeOf<T extends object>(stored: T | undefined, next: T): ApplyOutcome {
  if (stored === undefined) {
    return "created";
  }
  const same = (Object.keys(next) as (keyof T)[]).every((key) => stored[key] === next[key]);
  return same ? "unchanged" : "updated";
}
