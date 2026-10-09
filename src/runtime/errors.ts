import { BuPaymentError, publicError } from "@bu-payment/node-sdk";

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

const UPSTREAM_MESSAGE = "BuPayment could not complete the request.";

const CALLER_FAULT: FailureView = {
  status: 400,
  code: "request_invalid",
  message: "The request could not be read.",
};

export function apiErrorOf(error: unknown): string | null {
  const apiError = error instanceof BuPaymentError ? error.metadata?.apiError : undefined;
  return typeof apiError === "string" ? apiError : null;
}

export function describeFailure(error: unknown): FailureView {
  if (error instanceof BuPaymentError) {
    const { status, code } = publicError(error);
    return { status, code, message: UPSTREAM_MESSAGE };
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
