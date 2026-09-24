import type { Server } from "node:http";
import type { AppContext } from "../runtime/context";
import { createApp } from "./app";

export function startServer(context: AppContext): Server {
  const { host, port } = context.server;
  const server = createApp(context).listen(port, host, () => {
    context.logger.info("Playground is listening", {
      url: `http://${host}:${boundPort(server) ?? port}`,
      environment: context.client.environment,
    });
  });
  server.on("error", (error: NodeJS.ErrnoException) => {
    context.logger.error("Playground could not listen", {
      host,
      port,
      code: error.code ?? "unknown",
    });
    process.exitCode = 1;
  });
  return server;
}

function boundPort(server: Server): number | undefined {
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : undefined;
}
