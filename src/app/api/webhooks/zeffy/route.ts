import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isValidZeffyWebhookToken, processZeffyWebhookPayment } from "@/lib/zeffy";

export async function POST(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    // Fail closed: if no secret is configured, reject rather than accept anonymous
    // webhooks (which could create donations).
    if (!isValidZeffyWebhookToken(searchParams.get("token"), process.env.ZEFFY_WEBHOOK_SECRET)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();

    // Zeffy webhook sends payment events with a type field
    const eventType = body.type || body.event_type;
    if (eventType !== "payment.completed") {
      return NextResponse.json({ received: true });
    }

    const payment = body.data || body.payment;
    if (!payment?.id) {
      return NextResponse.json({ error: "Missing payment data" }, { status: 400 });
    }

    // Look up the office that has a Zeffy integration connected.
    // Zeffy webhooks don't include office info, so we find the office
    // that has a zeffy token configured.
    const zeffyTokens = await prisma.integrationToken.findMany({
      where: { provider: "zeffy" },
      select: { officeId: true },
    });

    // Process for each connected office
    for (const token of zeffyTokens) {
      await processZeffyWebhookPayment(payment, token.officeId);
    }

    return NextResponse.json({ received: true });
  } catch (error) {
    console.error("Zeffy webhook error:", error);
    return NextResponse.json({ error: "Webhook handler failed" }, { status: 500 });
  }
}
