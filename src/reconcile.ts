import { runReconciliation } from "./catalogue/command";
import { createLogger } from "./runtime/logger";

process.exitCode = await runReconciliation(createLogger());
