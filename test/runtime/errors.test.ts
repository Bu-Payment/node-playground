import { BuPaymentError } from "@bu-payment/node-sdk";
import { describe, expect, it } from "vitest";
import { describeFailure } from "../../src/runtime/errors";

describe("describeFailure", () => {
  it("passes through the canonical code and status of an SDK error", () => {
    const failure = describeFailure(
      new BuPaymentError("Application authentication is required", {
        code: "application_auth_required",
        status: 401,
      }),
    );

    expect(failure).toEqual({
      status: 401,
      code: "application_auth_required",
      message: "Application authentication is required",
    });
  });

  it("defaults an SDK error without a status to a bad gateway", () => {
    const failure = describeFailure(
      new BuPaymentError("Network unavailable", { code: "network_unavailable" }),
    );

    expect(failure.status).toBe(502);
  });

  it("says nothing about an unrecognized failure", () => {
    const failure = describeFailure(new Error("connect ECONNREFUSED 10.0.0.7:5432"));

    expect(failure).toEqual({
      status: 500,
      code: "internal_error",
      message: "The playground could not complete the request.",
    });
    expect(JSON.stringify(failure)).not.toContain("ECONNREFUSED");
  });

  it("blames the caller for a parser failure that carries a 4xx status", () => {
    const failure = describeFailure(Object.assign(new Error("Unexpected token"), { status: 400 }));

    expect(failure).toEqual({
      status: 400,
      code: "request_invalid",
      message: "The request could not be read.",
    });
  });

  it("reads statusCode when status is absent", () => {
    expect(describeFailure(Object.assign(new Error("too large"), { statusCode: 413 })).status).toBe(
      413,
    );
  });

  it.each([
    { status: 500 },
    { status: "400" },
    {},
  ])("treats %o as an unexpected failure rather than a caller fault", (extra) => {
    expect(describeFailure(Object.assign(new Error("boom"), extra)).code).toBe("internal_error");
  });

  it("treats a thrown non-object as an unexpected failure", () => {
    expect(describeFailure("boom").code).toBe("internal_error");
  });
});
