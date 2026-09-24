import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startServer } from "../../src/http/server";
import { testContext } from "../fixtures";

const running: Server[] = [];

function start(port: number) {
  const { context, lines } = testContext();
  const server = startServer({ ...context, server: { host: "127.0.0.1", port } });
  running.push(server);
  return { server, lines };
}

function settled(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.once("listening", () => resolve());
    server.once("error", () => resolve());
  });
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => new Promise((done) => server.close(done))));
  process.exitCode = 0;
});

describe("startServer", () => {
  it("announces the port it actually bound", async () => {
    const { server, lines } = start(0);
    await settled(server);

    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    expect(JSON.parse(lines[0] ?? "{}")).toEqual({
      level: "info",
      message: "Playground is listening",
      url: `http://127.0.0.1:${port}`,
      environment: "test",
    });
  });

  it("reports a listen failure as one log line instead of an uncaught exception", async () => {
    const { server, lines } = start(9003);
    await settled(server);
    lines.length = 0;

    server.emit("error", Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" }));

    expect(JSON.parse(lines[0] ?? "{}")).toEqual({
      level: "error",
      message: "Playground could not listen",
      host: "127.0.0.1",
      port: 9003,
      code: "EADDRINUSE",
    });
    expect(process.exitCode).toBe(1);
  });

  it("names an unlabelled listen failure rather than logging undefined", async () => {
    const { server, lines } = start(0);
    await settled(server);
    lines.length = 0;

    server.emit("error", new Error("something went wrong"));

    expect(JSON.parse(lines[0] ?? "{}").code).toBe("unknown");
  });
});
