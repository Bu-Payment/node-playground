import type { Server } from "node:http";
import type { AppContext } from "../runtime/context";
import { createApp } from "./app";

export function startServer(context: AppContext): Server {
  const { host, port } = context.server;
  const server = createApp(context).listen(port, host);
  server.on("listening", () => {
    context.logger.info("Playground is listening", {
      url: `http://${formatHost(host)}:${port}`,
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

function formatHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}
