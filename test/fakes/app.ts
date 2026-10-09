import type { FetchLike } from "@bu-payment/node-sdk";
import { emptyCatalogue, type MerchantProduct, putProduct } from "../../src/catalogue/merchant";
import { memoryStore } from "../../src/catalogue/store";
import { createApp } from "../../src/http/app";
import type { EnvSource } from "../../src/runtime/env";
import { testContext } from "../fixtures";
import { unreachableApi } from "./catalogue-api";

export function appWith(
  products: MerchantProduct[],
  fetch: FetchLike = unreachableApi(),
  env: EnvSource = {},
) {
  const catalogue = emptyCatalogue();
  for (const entry of products) {
    putProduct(catalogue, entry);
  }
  const store = memoryStore(catalogue);
  const { context, lines } = testContext(env, { fetch });
  return { app: createApp({ ...context, catalogue: store }), store, lines };
}
