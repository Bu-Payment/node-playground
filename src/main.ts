import { createApp } from "./http/app";
import { createContext } from "./runtime/context";
import { parseEnv } from "./runtime/env";
import { createLogger } from "./runtime/logger";

const logger = createLogger();

try {
  const context = createContext(parseEnv(), logger);
  createApp(context).listen(context.server.port, context.server.host, () => {
    logger.info("Playground is listening", {
      url: `http://${context.server.host}:${context.server.port}`,
      environment: context.client.environment,
    });
  });
} catch (error) {
  logger.error(error instanceof Error ? error.message : "Playground could not start");
  process.exitCode = 1;
}
