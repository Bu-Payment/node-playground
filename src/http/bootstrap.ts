import type { Server } from "node:http";
import { createContext } from "../runtime/context";
import { type EnvSource, parseEnv } from "../runtime/env";
import type { Logger } from "../runtime/logger";
import { startServer } from "./server";

export function bootstrap(logger: Logger, source?: EnvSource): Server | undefined {
  try {
    return startServer(createContext(parseEnv(source), logger));
  } catch (error) {
    logger.error(error instanceof Error ? error.message : "Playground could not start");
    process.exitCode = 1;
    return undefined;
  }
}
