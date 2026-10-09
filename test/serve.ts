import { once } from "node:events";
import { createServer, type RequestListener } from "node:http";
import supertest from "supertest";
import { onTestFinished } from "vitest";

export async function serve(app: RequestListener) {
  const server = createServer(app);
  onTestFinished(() => new Promise<void>((done) => server.close(() => done())));
  await once(server.listen(0, "127.0.0.1"), "listening");
  return supertest(server);
}
