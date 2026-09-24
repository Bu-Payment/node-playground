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

export function describeFailure(error: unknown): FailureView {
  if (error instanceof BuPaymentError) {
    return { status: error.status ?? 502, code: error.code, message: error.message };
  }
  return UNEXPECTED;
}
