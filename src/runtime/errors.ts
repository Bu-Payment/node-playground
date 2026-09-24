import { BuPaymentError } from "@bu-payment/node-sdk";

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export interface FailureView {
  status: number;
  code: string;
  message: string;
}

const UNEXPECTED: FailureView = {
  status: 500,
  code: "internal_error",
  message: "The playground could not complete the request.",
};

const CALLER_FAULT: FailureView = {
  status: 400,
  code: "request_invalid",
  message: "The request could not be read.",
};

export function describeFailure(error: unknown): FailureView {
  if (error instanceof BuPaymentError) {
    return { status: error.status ?? 502, code: error.code, message: error.message };
  }
  const status = callerStatus(error);
  if (status !== undefined) {
    return { ...CALLER_FAULT, status };
  }
  return UNEXPECTED;
}

function callerStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const status = (error as { status?: unknown; statusCode?: unknown }).status;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  const candidate = typeof status === "number" ? status : statusCode;
  if (typeof candidate !== "number" || candidate < 400 || candidate > 499) {
    return undefined;
  }
  return candidate;
}
