import type { Server } from "node:http";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startServer } from "../../src/http/server";
import { testContext } from "../fixtures";

const running: Server[] = [];

function start(port: number, host = "127.0.0.1") {
  const { context, lines } = testContext();
  const server = startServer({ ...context, server: { host, port } });
  running.push(server);
  return { server, lines };
}

function settled(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.once("listening", () => resolve());
    server.once("error", () => resolve());
  });
}

function occupyPort(): Promise<number> {
  return new Promise((resolve) => {
    const blocker = createServer();
    running.push(blocker as unknown as Server);
    blocker.listen(0, "127.0.0.1", () => {
      const address = blocker.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => new Promise((done) => server.close(done))));
  process.exitCode = 0;
});

describe("startServer", () => {
  it("announces the address it was asked to bind", async () => {
    const port = await occupyPort();
    for (const blocker of running.splice(0)) {
      blocker.close();
    }

    const { server, lines } = start(port);
    await settled(server);

    expect(JSON.parse(lines[0] ?? "{}")).toEqual({
      level: "info",
      message: "Playground is listening",
      url: `http://127.0.0.1:${port}`,
      environment: "test",
    });
    expect(process.exitCode).not.toBe(1);
  });

  it("reports a port already in use instead of announcing a server that is not there", async () => {
    const port = await occupyPort();

    const { server, lines } = start(port);
    await settled(server);

    expect(JSON.parse(lines[0] ?? "{}")).toEqual({
      level: "error",
      message: "Playground could not listen",
      host: "127.0.0.1",
      port,
      code: "EADDRINUSE",
    });
    expect(lines).toHaveLength(1);
    expect(process.exitCode).toBe(1);
  });

  it("brackets an IPv6 host so the announced URL stays a URL", async () => {
    const { server, lines } = start(0, "::1");
    await settled(server);

    expect(JSON.parse(lines[0] ?? "{}").url).toBe("http://[::1]:0");
  });
});
