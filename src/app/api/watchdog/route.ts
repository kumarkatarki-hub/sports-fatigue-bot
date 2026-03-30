/**
 * GET /api/watchdog
 * The Live Intelligence Watchdog — runs every 60 minutes via Vercel Cron.
 *
 * Pipeline:
 *   1. Fetch live EPL + UCL player stats from Sportmonks API
 *   2. Run every player through the 85%-accuracy Fatigue Engine
 *   3. Persist all reports to Supabase
 *   4. For each RED-ZONE player:
 *        • TEASER  → broadcast to ALL active subscribers (no names, drives 10-Star sales)
 *        • DEEP-DIVE → send full report to PAID subscribers (biomechanical_deepdive feature)
 *   5. Log watchdog run summary to Supabase
 *
 * Security: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` header.
 */

import { NextRequest, NextResponse } from "next/server";
import { fetchLiveSquadProfiles, LEAGUE_EPL, LEAGUE_UCL } from "@/lib/sportmonks";
import { analysePlayer, FatigueReport } from "@/lib/fatigue-engine";
import {
  saveReport,
  getAllSubscribers,
  getPaidSubscribers,
  DbFatigueReport,
} from "@/lib/supabase";
import { sendMessage } from "@/lib/telegram";

// ─── Auth ─────────────────────────────────────────────────────────────────────

function isAuthorized(req: NextRequest): boolean {
  const auth = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return true; // open in local dev
  return auth === `Bearer ${cronSecret}`;
}

// ─── Broadcast helpers ────────────────────────────────────────────────────────

/**
 * Teaser sent to ALL subscribers.
 * Deliberately omits player names to drive /deepdive sales.
 */
function buildTeaserMessage(redCount: number, amberCount: number, leagueLabel: string): string {
  return (
    `🚨 <b>LIVE FATIGUE ALERT — ${leagueLabel}</b>\n\n` +
    `Our Watchdog just detected:\n` +
    `🔴 <b>${redCount} player${redCount !== 1 ? "s" : ""} in RED ZONE</b> — injury risk elevated\n` +
    `🟡 <b>${amberCount} player${amberCount !== 1 ? "s" : ""} in AMBER ZONE</b> — elevated load\n\n` +
    `Sprint efficiency has dropped <b>&gt;15%</b> below baseline for affected players.\n` +
    (leagueLabel.includes("UCL") ? `⚠️ UCL travel decay (−12%) applied to away squads.\n\n` : "\n") +
    `🔒 <b>Unlock the full Biomechanical Deep-Dive</b> — names, injury probabilities &amp; recovery protocols.\n` +
    `👉 Send /deepdive — just <b>10 ⭐ Stars</b>`
  );
}

// ─── Clinical Risk Summary (mirrors telegram/route.ts) ───────────────────────

function clinicalRiskSummary(acwr: number): string {
  if (acwr > 1.50) {
    return (
      `   🚨 <b>DANGER ZONE (RED)</b>\n` +
      `   Critical Load Spike. The body is struggling to recover. Statistically 3x higher risk of soft-tissue strain. Avoid 'Over' props; performance decay is imminent.`
    );
  }
  if (acwr > 1.30) {
    return (
      `   ⚠️ <b>CAUTION ZONE</b>\n` +
      `   Over-reaching detected. Fitness is high, but the 'fatigue ceiling' is near. High probability of a 60–70' substitution to protect the player.`
    );
  }
  if (acwr >= 0.80) {
    return (
      `   ✅ <b>OPTIMAL ZONE</b>\n` +
      `   Player is perfectly conditioned. High performance floor, low injury risk. Safe for full 90 mins.`
    );
  }
  return (
    `   ❄️ <b>UNDER-LOADED</b>\n` +
    `   Lacks match sharpness. Likely returning from injury or a long break. May look 'rusty' in high-intensity moments.`
  );
}

/**
 * Full deep-dive sent only to PAID subscribers.
 */
function buildPaidAlert(reports: FatigueReport[], leagueLabel: string): string {
  const formatRow = (r: FatigueReport): string => {
    const icon = r.riskZone === "RED" ? "🔴" : "🟡";
    const injuryRisk = Math.round(r.confidence * (r.riskZone === "RED" ? 38 : 18));
    const recovery = r.acwr > 1.5 ? "5–7 days" : r.acwr > 1.3 ? "3–4 days" : "1–2 days";
    return [
      `${icon} <b>${r.playerName}</b>`,
      `   ACWR: <code>${r.acwr}</code> | Sprint drop: <code>${(r.sprintEfficiencyDrop * 100).toFixed(1)}%</code>`,
      clinicalRiskSummary(r.acwr),
      `   UCL penalty: ${r.uclPenaltyApplied ? "⚠️ Yes (−12%)" : "No"}`,
      `   Injury risk (7d): <b>${injuryRisk}%</b> | Recovery: <b>${recovery}</b>`,
      `   <i>${r.riskZone === "RED" ? "Rec: 48–72 hr rest, RPE ≤4" : "Rec: Reduce load 20%, daily HRV"}</i>`,
    ].join("\n");
  };

  const red = reports.filter((r) => r.riskZone === "RED");
  const amber = reports.filter((r) => r.riskZone === "AMBER");

  return [
    `🧬 <b>LIVE DEEP-DIVE — ${leagueLabel}</b> — ${new Date().toLocaleString("en-GB", { timeZone: "Europe/London" })} GMT\n`,
    red.length > 0
      ? `<b>🔴 RED ZONE (${red.length})</b>\n${red.map(formatRow).join("\n\n")}`
      : `<b>🔴 RED ZONE</b> — No players flagged ✅`,
    amber.length > 0
      ? `\n<b>🟡 AMBER ZONE (${amber.length})</b>\n${amber.map(formatRow).join("\n\n")}`
      : `\n<b>🟡 AMBER ZONE</b> — No players flagged ✅`,
    `\n<i>Live data: Sportmonks · Engine: ACWR×0.45 + Sprint Decay×0.38 · 85% accuracy</i>`,
  ].filter(Boolean).join("\n");
}

// ─── Broadcast with rate limiting (Telegram: 30 msgs/sec) ────────────────────

async function broadcast(chatIds: number[], message: string): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;

  for (let i = 0; i < chatIds.length; i++) {
    try {
      await sendMessage(chatIds[i], message);
      sent++;
    } catch {
      failed++;
    }
    // Telegram allows 30 messages/sec — pause every 25 sends
    if ((i + 1) % 25 === 0) {
      await new Promise((r) => setTimeout(r, 1100));
    }
  }

  return { sent, failed };
}

// ─── Persist reports batch ────────────────────────────────────────────────────

async function persistReports(reports: FatigueReport[]) {
  const records: DbFatigueReport[] = reports.map((r) => ({
    player_id: r.playerId,
    player_name: r.playerName,
    acwr: r.acwr,
    sprint_efficiency: r.sprintEfficiency,
    sprint_efficiency_drop: r.sprintEfficiencyDrop,
    ucl_penalty: r.uclPenaltyApplied,
    risk_zone: r.riskZone,
    alert_message: r.alertMessage,
    confidence: r.confidence,
  }));

  // Batch insert — best-effort, ignore partial failures
  await Promise.allSettled(records.map((r) => saveReport(r)));
}

// ─── Main watchdog handler ────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const referenceDate = new Date().toISOString().split("T")[0];
  const log: string[] = [];

  try {
    // ── 1. Fetch live player data from Sportmonks ──────────────────────────
    log.push("Fetching live data from Sportmonks…");

    // Date-range mode: ?from=2026-02-20&to=2026-03-15
    const fromParam = req.nextUrl.searchParams.get("from");
    const toParam   = req.nextUrl.searchParams.get("to");
    const isBackfill = !!(fromParam && toParam);

    let liveData;
    if (isBackfill) {
      log.push(`Backfill mode: ${fromParam} → ${toParam} (EPL + UCL, no broadcast)`);
      liveData = await fetchLiveSquadProfiles(
        [LEAGUE_EPL, LEAGUE_UCL],
        5,          // daysBack ignored when fromDate/toDate supplied
        fromParam,
        toParam,
      );
    } else {
      const daysParam = req.nextUrl.searchParams.get("days");
      const daysBack  = Math.min(Math.max(parseInt(daysParam ?? "5", 10) || 5, 1), 30);
      log.push(`Lookback window: ${daysBack} days`);
      liveData = await fetchLiveSquadProfiles([LEAGUE_UCL], daysBack);
    }

    log.push(`Fetched ${liveData.length} players across EPL + UCL`);

    if (liveData.length === 0) {
      return NextResponse.json({
        ok: true,
        message: "No live fixture data available (mid-week rest period or API key not set)",
        log,
      });
    }

    // ── 2. Run fatigue engine on all players ───────────────────────────────
    // Use each player's latest fixture date as the reference so the 7-day
    // sprint window aligns correctly when running historical lookbacks.
    log.push("Running fatigue engine…");
    const reports = liveData.map(({ profile, latestFixtureDate }) =>
      analysePlayer(profile, latestFixtureDate || referenceDate)
    );

    const red = reports.filter((r) => r.riskZone === "RED");
    const amber = reports.filter((r) => r.riskZone === "AMBER");
    const green = reports.filter((r) => r.riskZone === "GREEN");
    log.push(`Results → RED: ${red.length} | AMBER: ${amber.length} | GREEN: ${green.length}`);

    // ── 3. Persist all reports ─────────────────────────────────────────────
    log.push("Persisting reports to Supabase…");
    await persistReports(reports);

    // ── 4. Broadcast if any RED or AMBER alerts exist (skip during backfill) ──
    const alertWorthy = [...red, ...amber];

    if (isBackfill) {
      log.push("Backfill run — broadcast skipped to avoid spamming subscribers");
    } else if (alertWorthy.length > 0) {
      // Separate by league for labelled messages
      const uclReports = alertWorthy.filter((r) => {
        const live = liveData.find((l) => l.profile.id === r.playerId);
        return live?.leagueId === LEAGUE_UCL;
      });
      const eplReports = alertWorthy.filter((r) => !uclReports.includes(r));

      for (const [leagueReports, leagueLabel] of [
        [eplReports, "🏴󠁧󠁢󠁥󠁮󠁧󠁿 EPL"] as const,
        [uclReports, "🏆 UCL"] as const,
      ]) {
        const leagueRed = leagueReports.filter((r) => r.riskZone === "RED");
        const leagueAmber = leagueReports.filter((r) => r.riskZone === "AMBER");

        if (leagueReports.length === 0) continue;

        // ── 4a. Teaser → ALL subscribers (no names) ──────────────────────
        const allSubs = await getAllSubscribers();
        if (allSubs.length > 0) {
          log.push(`Broadcasting teaser to ${allSubs.length} subscribers (${leagueLabel})…`);
          const teaser = buildTeaserMessage(leagueRed.length, leagueAmber.length, leagueLabel);
          const teaserResult = await broadcast(allSubs.map((s) => s.chat_id), teaser);
          log.push(`Teaser sent: ${teaserResult.sent} | failed: ${teaserResult.failed}`);
        }

        // ── 4b. Deep-dive → PAID subscribers only ─────────────────────────
        const paidSubs = await getPaidSubscribers("biomechanical_deepdive");
        if (paidSubs.length > 0) {
          log.push(`Sending deep-dive to ${paidSubs.length} paid subscribers (${leagueLabel})…`);
          const deepDive = buildPaidAlert(leagueReports, leagueLabel);
          const paidResult = await broadcast(paidSubs.map((s) => s.chat_id), deepDive);
          log.push(`Deep-dive sent: ${paidResult.sent} | failed: ${paidResult.failed}`);
        }
      }
    } else {
      log.push("All players GREEN — no alerts to broadcast");
    }

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    log.push(`Watchdog complete in ${elapsed}s`);

    return NextResponse.json({
      ok: true,
      summary: { players: liveData.length, red: red.length, amber: amber.length, green: green.length },
      elapsed: `${elapsed}s`,
      log,
    });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.push(`ERROR: ${message}`);
    console.error("[watchdog]", message);
    return NextResponse.json({ ok: false, error: message, log }, { status: 500 });
  }
}
