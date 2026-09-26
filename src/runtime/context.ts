import {
  type BuPaymentClient,
  type ClientConfig,
  type ClientOptions,
  createBuPaymentClient,
  parseClientConfig,
} from "@bu-payment/node-sdk";
import { type CatalogueStore, fileStore } from "../catalogue/store";
import type { Env } from "./env";
import type { Logger } from "./logger";

export interface ServerAddress {
  host: string;
  port: number;
}

export interface AppContext {
  readonly client: ClientConfig;
  readonly bupayment: BuPaymentClient;
  readonly catalogue: CatalogueStore;
  readonly server: ServerAddress;
  readonly logger: Logger;
}

export function createContext(env: Env, logger: Logger, options: ClientOptions = {}): AppContext {
  const credentials = {
    applicationId: env.BUPAYMENT_APP_ID,
    keyId: env.BUPAYMENT_KEY_ID,
    secret: env.BUPAYMENT_SECRET,
    apiBaseUrl: env.BUPAYMENT_API_BASE_URL,
  };
  return {
    client: parseClientConfig(credentials),
    bupayment: createBuPaymentClient(credentials, options),
    catalogue: fileStore(env.CATALOGUE_STORE_PATH),
    server: { host: env.HOST, port: env.PORT },
    logger,
  };
}
