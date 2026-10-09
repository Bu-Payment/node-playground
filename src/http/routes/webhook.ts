import { BuPaymentError, type WebhookHeaders, webhookDelivery } from "@bu-payment/node-sdk";
import type { RequestHandler } from "express";
import { receiveDelivery } from "../../catalogue/webhook";
import type { AppContext } from "../../runtime/context";

export function webhookRoute(context: AppContext): RequestHandler {
  return async (request, response) => {
    const secret = context.webhookSecret;
    if (secret === null) {
      response
        .status(503)
        .json({ code: "webhook_not_configured", message: "No webhook endpoint secret is set." });
      return;
    }
    const body: unknown = request.body;
    const delivery = verify(
      body instanceof Buffer ? body : Buffer.alloc(0),
      request.headers,
      secret,
    );
    if (delivery instanceof BuPaymentError) {
      context.logger.error("Webhook delivery refused", { code: delivery.code });
      response.status(400).json({ code: delivery.code, message: "The delivery was refused." });
      return;
    }
    const report = await receiveDelivery(context.bupayment.catalogue, context.catalogue, delivery);
    context.logger.info("Webhook delivery received", {
      eventId: delivery.event.id,
      type: delivery.event.type,
      outcome: report.outcome,
      applied: report.applied.length,
      stale: report.stale.length,
      replacements: report.replacements.length,
    });
    response.json({ received: true, outcome: report.outcome });
  };
}

function verify(body: Buffer, headers: WebhookHeaders, secret: string) {
  try {
    return webhookDelivery().secret(secret).body(body).headers(headers).verify();
  } catch (error) {
    if (error instanceof BuPaymentError) {
      return error;
    }
    throw error;
  }
}
