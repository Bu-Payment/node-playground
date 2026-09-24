import { startServer } from "./http/server";
import { createContext } from "./runtime/context";
import { parseEnv } from "./runtime/env";
import { createLogger } from "./runtime/logger";

const logger = createLogger();

try {
  startServer(createContext(parseEnv(), logger));
} catch (error) {
  logger.error(error instanceof Error ? error.message : "Playground could not start");
  process.exitCode = 1;
}
