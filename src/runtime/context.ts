import { type ClientConfig, parseClientConfig } from "@bu-payment/node-sdk";
import type { Env } from "./env";
import type { Logger } from "./logger";

export interface ServerAddress {
  host: string;
  port: number;
}

export interface AppContext {
  readonly client: ClientConfig;
  readonly server: ServerAddress;
  readonly logger: Logger;
}

export function createContext(env: Env, logger: Logger): AppContext {
  return {
    client: parseClientConfig({
      applicationId: env.BUPAYMENT_APP_ID,
      keyId: env.BUPAYMENT_KEY_ID,
      secret: env.BUPAYMENT_SECRET,
      apiBaseUrl: env.BUPAYMENT_API_BASE_URL,
    }),
    server: { host: env.HOST, port: env.PORT },
    logger,
  };
}
