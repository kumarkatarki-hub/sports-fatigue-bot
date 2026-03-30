/**
 * GET /api/register-webhook?url=https://your-domain.vercel.app
 * Call this once after deploying to Vercel to register the Telegram webhook.
 */
import { NextRequest, NextResponse } from "next/server";
import { setWebhook } from "@/lib/telegram";

export async function GET(req: NextRequest) {
  const siteUrl = req.nextUrl.searchParams.get("url") ??
    process.env.NEXT_PUBLIC_SITE_URL;

  if (!siteUrl) {
    return NextResponse.json({ error: "Provide ?url=https://your-domain" }, { status: 400 });
  }

  const webhookUrl = `${siteUrl}/api/telegram`;
  const secret = process.env.WEBHOOK_SECRET ?? "changeme";

  const result = await setWebhook(webhookUrl, secret);
  return NextResponse.json(result);
}
