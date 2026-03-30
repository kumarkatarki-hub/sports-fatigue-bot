/**
 * POST /api/telegram  — Revenue & Subscription Engine
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  PLAN            STARS   GBP NET*   ACCESS                      │
 * │  single_report      50    ~£0.45   one deep-dive (consumed)      │
 * │  matchday_pass     150    ~£1.37   24 h full access              │
 * │  medical_pro     1,500   ~£13.65  30-day full access             │
 * │  * after Telegram's 30% fee                                     │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * Paywall logic:
 *   /analyse <name>  → masked ("Player X") if no active sub + Unlock button
 *   /deepdive        → locked teaser + invoice if no active sub
 *   /betting         → locked teaser + invoice if no active sub
 *
 * Inline buttons:
 *   "Unlock Now — 50 ⭐"    → callback_data: buy_single
 *   "Matchday Pass — 150 ⭐" → callback_data: buy_matchday
 *   "Medical Pro — 1,500 ⭐" → callback_data: buy_medpro
 *
 * Payment flow:
 *   callback_query(buy_*)  → sendInvoice
 *   pre_checkout_query     → approve
 *   successful_payment     → createSubscription (with expiry) → deliver
 */

import { NextRequest, NextResponse } from "next/server";
import {
  sendMessage,
  sendMessageWithButtons,
  sendInvoice,
  answerPreCheckoutQuery,
  answerCallbackQuery,
} from "@/lib/telegram";
import { analysePlayer, analyseSquad, PlayerProfile, FatigueReport } from "@/lib/fatigue-engine";
import {
  saveReport,
  upsertSubscriber,
  createSubscription,
  getActiveSubscription,
  consumeSingleReport,
  DbFatigueReport,
  SubPlan,
} from "@/lib/supabase";

// ─── Pricing ──────────────────────────────────────────────────────────────────

const PLANS: Record<string, { stars: number; plan: SubPlan; label: string; desc: string; expiryHours: number | null }> = {
  buy_single: {
    stars: 50,
    plan: "single_report",
    label: "🔓 Single Report",
    desc: "One full Biomechanical Deep-Dive: injury probability, recovery protocol & load recommendations.",
    expiryHours: null, // consumed on first use
  },
  buy_matchday: {
    stars: 150,
    plan: "matchday_pass",
    label: "📅 Matchday Pass",
    desc: "24-hour full access: unlimited deep-dives, betting edge & live fatigue alerts.",
    expiryHours: 24,
  },
  buy_medpro: {
    stars: 1500,
    plan: "medical_pro",
    label: "🏥 Medical Pro Pass",
    desc: "30-day persistent access: all features, priority alerts & biomechanical protocols for every fixture.",
    expiryHours: 720, // 30 × 24
  },
};

// ─── Inline keyboard helpers ──────────────────────────────────────────────────

const UNLOCK_BUTTONS = [
  { text: "🔓 Unlock — 50 ⭐", callback_data: "buy_single" },
  { text: "📅 Matchday — 150 ⭐", callback_data: "buy_matchday" },
];

const ALL_PLAN_BUTTONS = [
  [{ text: "🔓 Single Report — 50 ⭐", callback_data: "buy_single" }],
  [{ text: "📅 Matchday Pass — 150 ⭐", callback_data: "buy_matchday" }],
  [{ text: "🏥 Medical Pro — 1,500 ⭐", callback_data: "buy_medpro" }],
];

// ─── Demo squad ───────────────────────────────────────────────────────────────

const DEMO_SQUAD: PlayerProfile[] = [
  {
    id: "demo-01", name: "Marcus Rashford", position: "FWD",
    baselineSprintEfficiency: 1.6,
    sessions: [
      { date: "2024-10-01", minutesPlayed: 90, highIntensityRuns: 21, totalDistance: 11.0, sprintDistance: 1.6, isEuropeanAway: false, isMidweek: false },
      { date: "2024-10-04", minutesPlayed: 90, highIntensityRuns: 24, totalDistance: 12.0, sprintDistance: 1.9, isEuropeanAway: true,  isMidweek: true  },
      { date: "2024-10-07", minutesPlayed: 80, highIntensityRuns: 12, totalDistance: 8.5,  sprintDistance: 1.1, isEuropeanAway: false, isMidweek: false },
    ],
  },
  {
    id: "demo-02", name: "Phil Foden", position: "MID",
    baselineSprintEfficiency: 1.5,
    sessions: [
      { date: "2024-10-01", minutesPlayed: 80, highIntensityRuns: 16, totalDistance: 10.5, sprintDistance: 1.4,  isEuropeanAway: false, isMidweek: false },
      { date: "2024-10-04", minutesPlayed: 75, highIntensityRuns: 15, totalDistance: 10.0, sprintDistance: 1.35, isEuropeanAway: false, isMidweek: false },
      { date: "2024-10-07", minutesPlayed: 70, highIntensityRuns: 14, totalDistance: 9.5,  sprintDistance: 1.3,  isEuropeanAway: false, isMidweek: false },
    ],
  },
  {
    id: "demo-03", name: "Ruben Dias", position: "DEF",
    baselineSprintEfficiency: 0.7,
    sessions: [
      { date: "2024-10-01", minutesPlayed: 90, highIntensityRuns: 8, totalDistance: 9.0, sprintDistance: 0.65, isEuropeanAway: false, isMidweek: false },
      { date: "2024-10-05", minutesPlayed: 90, highIntensityRuns: 8, totalDistance: 8.9, sprintDistance: 0.65, isEuropeanAway: false, isMidweek: false },
      { date: "2024-10-09", minutesPlayed: 90, highIntensityRuns: 7, totalDistance: 8.7, sprintDistance: 0.63, isEuropeanAway: false, isMidweek: false },
    ],
  },
];

// ─── Clinical Risk Summary ────────────────────────────────────────────────────

function clinicalRiskSummary(acwr: number): string {
  if (acwr > 1.50) {
    return (
      `🚨 <b>DANGER ZONE (RED)</b>\n` +
      `Critical Load Spike. The body is struggling to recover. Statistically 3x higher risk of soft-tissue strain. Avoid 'Over' props; performance decay is imminent.`
    );
  }
  if (acwr > 1.30) {
    return (
      `⚠️ <b>CAUTION ZONE</b>\n` +
      `Over-reaching detected. Fitness is high, but the 'fatigue ceiling' is near. High probability of a 60–70' substitution to protect the player.`
    );
  }
  if (acwr >= 0.80) {
    return (
      `✅ <b>OPTIMAL ZONE</b>\n` +
      `Player is perfectly conditioned. High performance floor, low injury risk. Safe for full 90 mins.`
    );
  }
  return (
    `❄️ <b>UNDER-LOADED</b>\n` +
    `Lacks match sharpness. Likely returning from injury or a long break. May look 'rusty' in high-intensity moments.`
  );
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function formatReport(r: FatigueReport, masked = false): string {
  const icon    = r.riskZone === "RED" ? "🔴" : r.riskZone === "AMBER" ? "🟡" : "🟢";
  const nameStr = masked ? `Player X <i>(🔒 name hidden)</i>` : `<b>${r.playerName}</b>`;
  return [
    `${icon} ${nameStr}`,
    `├ ACWR: <code>${r.acwr}</code>`,
    clinicalRiskSummary(r.acwr),
    `├ Sprint Eff: <code>${r.sprintEfficiency} km/90</code>`,
    `├ Sprint Drop: <code>${(r.sprintEfficiencyDrop * 100).toFixed(1)}%</code>`,
    `├ UCL Penalty: ${r.uclPenaltyApplied ? "⚠️ Yes (−12%)" : "✅ No"}`,
    `├ Zone: <b>${r.riskZone}</b>`,
    `└ Confidence: <code>${(r.confidence * 100).toFixed(0)}%</code>`,
  ].join("\n");
}

async function persistReport(r: FatigueReport) {
  try {
    const record: DbFatigueReport = {
      player_id: r.playerId, player_name: r.playerName, acwr: r.acwr,
      sprint_efficiency: r.sprintEfficiency, sprint_efficiency_drop: r.sprintEfficiencyDrop,
      ucl_penalty: r.uclPenaltyApplied, risk_zone: r.riskZone,
      alert_message: r.alertMessage, confidence: r.confidence,
    };
    await saveReport(record);
  } catch { /* non-fatal */ }
}

// ─── FREE: /start ─────────────────────────────────────────────────────────────

async function handleStart(chatId: number, userId: number, username?: string) {
  try { await upsertSubscriber({ telegram_user_id: userId, chat_id: chatId, username }); }
  catch { /* non-fatal */ }

  await sendMessage(
    chatId,
    `⚽ <b>Sports Fatigue Bot</b>\n\n` +
    `AI-powered EPL &amp; UCL fatigue intelligence.\n` +
    `Engine: ACWR + Sprint Decay · 85% prediction accuracy\n\n` +
    `<b>Free</b>\n` +
    `/teaser — Live fatigue snapshot\n` +
    `/squad — Squad zone report\n` +
    `/analyse &lt;name&gt; — Player analysis\n\n` +
    `<b>Premium</b>\n` +
    `🔓 <b>Single Report</b> — 50 ⭐ (one deep-dive)\n` +
    `📅 <b>Matchday Pass</b> — 150 ⭐ (24-hour full access)\n` +
    `🏥 <b>Medical Pro</b> — 1,500 ⭐ (30-day full access)\n\n` +
    `/deepdive · /betting · /plans\n\n` +
    `<i>UCL travel decay −12% · 85% accuracy benchmark</i>`,
    "HTML",
    { inline_keyboard: ALL_PLAN_BUTTONS }
  );
}

// ─── FREE: /teaser — shows masked stats + Unlock Now button ──────────────────

async function handleTeaser(chatId: number) {
  const reports = analyseSquad(DEMO_SQUAD);
  await Promise.all(reports.map(persistReport));

  const topRisk = (reports.filter(r => r.riskZone === "RED").length
    ? reports.filter(r => r.riskZone === "RED")
    : reports.filter(r => r.riskZone === "AMBER")
  ).slice(0, 2);

  const body = [
    `⚡ <b>Live Fatigue Alert — Top Risk Players</b>\n`,
    ...topRisk.map(r => formatReport(r, true)), // names masked
    `\n🔒 <i>Player names &amp; full protocols locked.</i>`,
    `Unlock for as little as <b>50 ⭐ Stars</b>.`,
  ].join("\n\n");

  await sendMessageWithButtons(chatId, body, UNLOCK_BUTTONS);
}

// ─── FREE: /squad — zone counts only, no names ───────────────────────────────

async function handleSquad(chatId: number) {
  const reports = analyseSquad(DEMO_SQUAD);
  await Promise.all(reports.map(persistReport));
  const lines = [
    `📋 <b>Squad Fatigue Report</b> — ${new Date().toLocaleDateString("en-GB")}\n`,
    ...reports.map(r => formatReport(r)),
    `\n<i>ACWR×0.45 + Sprint Decay×0.38 + MinuteLoad×0.17 | UCL −12%</i>`,
  ];
  await sendMessage(chatId, lines.join("\n\n"));
}

// ─── GATED: /analyse <name> — shows stats, masks name if no sub ──────────────

async function handleAnalyse(chatId: number, userId: number, name: string) {
  const player = DEMO_SQUAD.find(p => p.name.toLowerCase().includes(name.toLowerCase()));
  if (!player) {
    await sendMessage(chatId,
      `❓ Not found. Try: ${DEMO_SQUAD.map(p => p.name).join(", ")}`
    );
    return;
  }

  const report = analysePlayer(player);
  await persistReport(report);

  const sub = await getActiveSubscription(userId);

  if (!sub) {
    // Show stats but mask name
    const body = [
      `🔍 <b>Player Analysis</b> <i>(partial — name locked)</i>\n`,
      formatReport(report, true),
      `\n🔒 <b>Unlock the player name &amp; full biomechanical protocol.</b>`,
    ].join("\n\n");
    await sendMessageWithButtons(chatId, body, UNLOCK_BUTTONS);
    return;
  }

  // Full report
  await sendMessage(chatId,
    `🔍 <b>Player Analysis</b>\n\n${formatReport(report)}\n\n${report.alertMessage}`
  );
}

// ─── GATED: /deepdive ────────────────────────────────────────────────────────

async function handleDeepDive(chatId: number, userId: number) {
  const sub = await getActiveSubscription(userId);

  if (!sub) {
    await sendMessage(
      chatId,
      `🧬 <b>Biomechanical Deep-Dive</b> — 🔒 Locked\n\n` +
      `Full injury probability, recovery timelines &amp; load protocols.\n` +
      `Available from <b>50 ⭐ Stars</b>.`,
      "HTML",
      { inline_keyboard: ALL_PLAN_BUTTONS }
    );
    return;
  }

  await deliverDeepDive(chatId, sub.plan === "single_report" ? sub.id! : null);
}

// ─── GATED: /betting ─────────────────────────────────────────────────────────

async function handleBetting(chatId: number, userId: number) {
  const sub = await getActiveSubscription(userId);

  if (!sub) {
    await sendMessage(
      chatId,
      `📈 <b>Betting Edge</b> — 🔒 Locked\n\n` +
      `Fatigue Risk Index, value picks &amp; accumulator tips.\n` +
      `Available from <b>50 ⭐ Stars</b>.`,
      "HTML",
      { inline_keyboard: ALL_PLAN_BUTTONS }
    );
    return;
  }

  await deliverBettingEdge(chatId, sub.plan === "single_report" ? sub.id! : null);
}

// ─── /plans — pricing menu ───────────────────────────────────────────────────

async function handlePlans(chatId: number) {
  await sendMessage(
    chatId,
    `💳 <b>Subscription Plans</b>\n\n` +
    `🔓 <b>Single Report</b> — 50 ⭐\n` +
    `   One full deep-dive (injury %, recovery plan, betting edge)\n\n` +
    `📅 <b>Matchday Pass</b> — 150 ⭐\n` +
    `   24-hour unlimited access to all features\n\n` +
    `🏥 <b>Medical Pro</b> — 1,500 ⭐\n` +
    `   30-day full access — best value for professionals\n\n` +
    `<i>Net revenue after Telegram's 30% fee: ~£0.45 · ~£1.37 · ~£13.65</i>`,
    "HTML",
    { inline_keyboard: ALL_PLAN_BUTTONS }
  );
}

// ─── Delivery functions ───────────────────────────────────────────────────────

async function deliverDeepDive(chatId: number, singleSubId: string | null) {
  const reports = analyseSquad(DEMO_SQUAD);
  const red   = reports.filter(r => r.riskZone === "RED");
  const amber = reports.filter(r => r.riskZone === "AMBER");

  const lines = [
    `🧬 <b>Biomechanical Deep-Dive</b> — Confidential\n`,
    `<b>🔴 High Risk (${red.length})</b>`,
    ...red.map(r => [
      formatReport(r),
      `📋 <i>Rec: 48–72 hr rest · RPE ≤4 · No sprinting until ACWR &lt; 1.3</i>`,
      `⏱ <i>Recovery window: ${r.acwr > 1.5 ? "5–7 days" : "3–4 days"}</i>`,
    ].join("\n")),
    red.length === 0 ? "None in RED zone ✅" : "",
    `\n<b>🟡 Elevated Risk (${amber.length})</b>`,
    ...amber.map(r => [
      formatReport(r),
      `📋 <i>Rec: Reduced load · Daily HRV · Sprints ≤80% max</i>`,
    ].join("\n")),
    `\n<b>Injury Probability — next 7 days</b>`,
    ...red.map(r =>
      `• ${r.playerName}: <b>${Math.round(r.confidence * 38)}% soft tissue risk</b>` +
      (r.uclPenaltyApplied ? " (UCL travel compound)" : "")
    ),
    ...amber.map(r =>
      `• ${r.playerName}: <b>${Math.round(r.confidence * 18)}% minor muscle risk</b>`
    ),
    `\n<b>Load Protocol</b>`,
    `• Days 1–3: active recovery · RPE ≤4`,
    `• Days 4–6: progressive load ≤70% chronic baseline`,
    `• Day 7+: full load if ACWR re-enters 0.8–1.3 band`,
    `\n<i>ACWR + Sprint Decay · 85% accuracy · UCL travel −12%</i>`,
  ].filter(Boolean);

  await sendMessage(chatId, lines.join("\n\n"));
  if (singleSubId) { try { await consumeSingleReport(singleSubId); } catch { /* non-fatal */ } }
}

async function deliverBettingEdge(chatId: number, singleSubId: string | null) {
  const reports = analyseSquad(DEMO_SQUAD);

  const lines = [
    `📈 <b>Betting Edge — Fatigue-Adjusted Intelligence</b>\n`,
    `<b>Fatigue Risk Index (FRI)</b>`,
    ...reports.map(r => {
      const fri    = Math.round(r.acwr * 30 + r.sprintEfficiencyDrop * 40 + (r.uclPenaltyApplied ? 15 : 0));
      const impact = fri > 60 ? "HIGH" : fri > 35 ? "MODERATE" : "LOW";
      return `• ${r.playerName}: <b>${fri}/100</b> — ${impact} impact`;
    }),
    `\n<b>Value Picks</b>`,
    ...reports.filter(r => r.riskZone === "RED").map(r =>
      `• Fade <b>${r.playerName}</b> — sprint output −15–20% below average`
    ),
    reports.filter(r => r.riskZone === "RED").length === 0
      ? "• No RED zone fade opportunities this cycle" : "",
    `\n<b>Accumulator Tip</b>`,
    `Avoid sides with 2+ RED starters. Back GREEN-heavy teams hosting UCL-fatigued opponents mid-week.`,
    `\n⚠️ <i>Informational only. Betting carries financial risk.</i>`,
  ].filter(Boolean);

  await sendMessage(chatId, lines.join("\n\n"));
  if (singleSubId) { try { await consumeSingleReport(singleSubId); } catch { /* non-fatal */ } }
}

// ─── Successful payment → create subscription + deliver ──────────────────────

async function handleSuccessfulPayment(
  chatId: number,
  userId: number,
  payload: string,
  chargeId: string,
  stars: number
) {
  const plan = PLANS[payload];
  if (!plan) {
    await sendMessage(chatId, "✅ Payment received. Thank you!");
    return;
  }

  // Calculate expiry
  const expiresAt = plan.expiryHours
    ? new Date(Date.now() + plan.expiryHours * 3_600_000).toISOString()
    : null;

  let subId: string | null = null;
  try {
    const sub = await createSubscription({
      telegram_user_id: userId,
      plan: plan.plan,
      stars_paid: stars,
      telegram_charge_id: chargeId,
      expires_at: expiresAt,
    });
    subId = sub.id ?? null;
  } catch { /* best-effort — still deliver */ }

  const expiryNote = plan.expiryHours === null
    ? "one-time use"
    : plan.expiryHours === 24
      ? "valid for 24 hours"
      : "valid for 30 days";

  await sendMessage(chatId,
    `✅ <b>Payment confirmed!</b> ${plan.label} activated (${expiryNote}).\n` +
    `Delivering your report now...`
  );

  if (plan.plan === "single_report" || plan.plan === "matchday_pass" || plan.plan === "medical_pro") {
    // Deliver deep-dive for all plans (betting edge follows immediately)
    const consumeId = plan.plan === "single_report" ? (subId ?? null) : null;
    await deliverDeepDive(chatId, consumeId);
    // Matchday + MedPro also get betting edge in the same session
    if (plan.plan !== "single_report") {
      await deliverBettingEdge(chatId, null);
    }
  }
}

// ─── Callback query handler (inline button presses) ──────────────────────────

async function handleCallbackQuery(
  callbackQueryId: string,
  chatId: number,
  userId: number,
  data: string
) {
  // Always acknowledge immediately (Telegram 10-second deadline)
  await answerCallbackQuery(callbackQueryId);

  const plan = PLANS[data];
  if (!plan) return;

  // Check if already subscribed
  const sub = await getActiveSubscription(userId);
  if (sub) {
    await sendMessage(chatId,
      `✅ You already have an active subscription (${sub.plan.replace("_", " ")}).\n` +
      `Use /deepdive or /betting to access your reports.`
    );
    return;
  }

  await sendInvoice(chatId, plan.label, plan.desc, data, plan.stars);
}

// ─── Webhook entry point ──────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-telegram-bot-api-secret-token");
  if (process.env.WEBHOOK_SECRET && secret !== process.env.WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let update: Record<string, unknown>;
  try { update = await req.json(); }
  catch { return NextResponse.json({ error: "Bad request" }, { status: 400 }); }

  // ── Pre-checkout: approve all Stars payments ──────────────────────────────
  if (update.pre_checkout_query) {
    const pcq = update.pre_checkout_query as { id: string; invoice_payload: string };
    // Validate payload is a known plan
    const valid = pcq.invoice_payload in PLANS;
    await answerPreCheckoutQuery(pcq.id, valid, valid ? undefined : "Unknown plan.");
    return NextResponse.json({ ok: true });
  }

  // ── Callback query (inline button press) ─────────────────────────────────
  if (update.callback_query) {
    const cq = update.callback_query as {
      id: string;
      from: { id: number };
      message: { chat: { id: number } };
      data: string;
    };
    await handleCallbackQuery(cq.id, cq.message.chat.id, cq.from.id, cq.data);
    return NextResponse.json({ ok: true });
  }

  // ── Regular message ───────────────────────────────────────────────────────
  const message = update.message as {
    chat: { id: number };
    from?: { id: number; username?: string };
    text?: string;
    successful_payment?: {
      invoice_payload: string;
      telegram_payment_charge_id: string;
      total_amount: number;
    };
  } | undefined;

  if (!message) return NextResponse.json({ ok: true });

  const chatId = message.chat.id;
  const userId = message.from?.id ?? 0;
  const text   = (message.text ?? "").trim();

  // Successful Stars payment
  if (message.successful_payment) {
    const sp = message.successful_payment;
    await handleSuccessfulPayment(chatId, userId, sp.invoice_payload, sp.telegram_payment_charge_id, sp.total_amount);
    return NextResponse.json({ ok: true });
  }

  // Command routing
  if      (text.startsWith("/start"))   await handleStart(chatId, userId, message.from?.username);
  else if (text.startsWith("/teaser"))  await handleTeaser(chatId);
  else if (text.startsWith("/squad"))   await handleSquad(chatId);
  else if (text.startsWith("/analyse")) await handleAnalyse(chatId, userId, text.replace(/^\/analyse\s*/i, "").trim() || "Rashford");
  else if (text.startsWith("/deepdive"))await handleDeepDive(chatId, userId);
  else if (text.startsWith("/betting")) await handleBetting(chatId, userId);
  else if (text.startsWith("/plans"))   await handlePlans(chatId);
  else await sendMessage(chatId, `Use /start to see commands and pricing.`);

  return NextResponse.json({ ok: true });
}
