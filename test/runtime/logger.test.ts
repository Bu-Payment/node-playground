import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../../src/runtime/logger";

describe("createLogger", () => {
  it("writes one JSON line per record", () => {
    const lines: string[] = [];
    const logger = createLogger((line) => lines.push(line));

    logger.info("Playground is listening", { port: 9003 });
    logger.error("Request failed", { status: 502 });

    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { level: "info", message: "Playground is listening", port: 9003 },
      { level: "error", message: "Request failed", status: 502 },
    ]);
  });

  it("writes to standard output when no writer is supplied", () => {
    const written: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    createLogger().info("Playground is listening");

    expect(written).toEqual(['{"level":"info","message":"Playground is listening"}\n']);
    write.mockRestore();
  });
});
