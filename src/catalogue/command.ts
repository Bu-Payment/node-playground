import type { ClientOptions } from "@bu-payment/node-sdk";
import { type AppContext, createContext } from "../runtime/context";
import { type EnvSource, parseEnv } from "../runtime/env";
import { describeFailure } from "../runtime/errors";
import type { Logger } from "../runtime/logger";
import { reconcileCatalogue } from "./reconcile";

export async function runReconciliation(
  logger: Logger,
  source?: EnvSource,
  options: ClientOptions = {},
): Promise<number> {
  let context: AppContext;
  try {
    context = createContext(parseEnv(source), logger, options);
  } catch (error) {
    logger.error(error instanceof Error ? error.message : "Reconciliation could not start");
    return 1;
  }
  try {
    const report = await reconcileCatalogue(context.bupayment.catalogue, context.catalogue);
    for (const change of report.changes) {
      logger.info("Catalogue link reconciled", { ...change });
    }
    for (const productId of report.unlinked) {
      logger.info("BuPayment product not linked to any local product", { productId });
    }
    logger.info("Catalogue reconciled", {
      products: report.observed.products,
      prices: report.observed.prices,
      changed: report.changes.length,
      inSync: report.inSync,
      unlinked: report.unlinked.length,
    });
    return 0;
  } catch (error) {
    const failure = describeFailure(error);
    logger.error("Catalogue reconciliation failed, local catalogue left untouched", {
      code: failure.code,
      status: failure.status,
    });
    return 1;
  }
}
