/**
 * Sports Fatigue Engine — EPL & UCL Edition
 *
 * KPI: 85% prediction accuracy (validated by backtester.ts)
 *
 * Core models:
 *  - ACWR  : Acute:Chronic Workload Ratio (7-day / 28-day rolling load)
 *  - Sprint Decay: Red-Zone if sprint efficiency drops >15% below baseline
 *  - UCL Penalty : 12% travel decay for midweek European away fixtures
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type RiskZone = "GREEN" | "AMBER" | "RED";

export interface SessionLoad {
  date: string; // ISO date "YYYY-MM-DD"
  minutesPlayed: number;
  highIntensityRuns: number; // count of runs >21 km/h
  totalDistance: number; // in km
  sprintDistance: number; // in km (>25 km/h)
  isEuropeanAway: boolean; // UCL/UEL away fixture
  isMidweek: boolean; // Tuesday / Wednesday
}

export interface PlayerProfile {
  id: string;
  name: string;
  position: "GK" | "DEF" | "MID" | "FWD";
  baselineSprintEfficiency: number; // km of sprints per 90 min (player historical avg)
  sessions: SessionLoad[];
}

export interface FatigueReport {
  playerId: string;
  playerName: string;
  acwr: number;
  sprintEfficiency: number; // current sprint km per 90 min
  sprintEfficiencyDrop: number; // % drop from baseline (positive = drop)
  uclPenaltyApplied: boolean;
  riskZone: RiskZone;
  alertMessage: string;
  confidence: number; // 0–1
  timestamp: string;
}

// ─── Weights (tuned to hit 85% accuracy benchmark) ─────────────────────────

export const WEIGHTS = {
  acwr: 0.45,
  sprintDecay: 0.38,
  minuteLoad: 0.17,
  // UCL travel decay multiplier
  uclTravelDecay: 0.12,
  // Red-Zone sprint efficiency drop threshold
  sprintRedZoneThreshold: 0.15,
  // ACWR danger band (> this = overload)
  acwrDangerHigh: 1.3,
  acwrDangerLow: 0.8,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function daysBetween(a: string, b: string): number {
  return Math.abs(
    (new Date(b).getTime() - new Date(a).getTime()) / (1000 * 60 * 60 * 24)
  );
}

function sessionsInWindow(sessions: SessionLoad[], referenceDate: string, windowDays: number): SessionLoad[] {
  return sessions.filter(
    (s) => daysBetween(s.date, referenceDate) <= windowDays && s.date <= referenceDate
  );
}

/** Composite load unit for a session (normalised to 90 min) */
function sessionLoad(s: SessionLoad): number {
  const minFactor = s.minutesPlayed / 90;
  return (s.totalDistance * 0.4 + s.sprintDistance * 0.6) * minFactor;
}

/** Average daily load over a window */
function avgLoad(sessions: SessionLoad[], referenceDate: string, windowDays: number): number {
  const window = sessionsInWindow(sessions, referenceDate, windowDays);
  if (window.length === 0) return 0;
  const total = window.reduce((sum, s) => sum + sessionLoad(s), 0);
  return total / windowDays;
}

// ─── ACWR Calculation ─────────────────────────────────────────────────────────

export function calculateACWR(sessions: SessionLoad[], referenceDate: string): number {
  const acute = avgLoad(sessions, referenceDate, 7);
  const chronic = avgLoad(sessions, referenceDate, 28);
  if (chronic === 0) return 1.0; // no history → neutral
  return acute / chronic;
}

// ─── Sprint Efficiency ────────────────────────────────────────────────────────

export function calculateSprintEfficiency(
  sessions: SessionLoad[],
  referenceDate: string,
  windowDays = 7
): number {
  const recent = sessionsInWindow(sessions, referenceDate, windowDays);
  if (recent.length === 0) return 0;
  const totalMinutes = recent.reduce((s, r) => s + r.minutesPlayed, 0);
  if (totalMinutes === 0) return 0;
  const totalSprints = recent.reduce((s, r) => s + r.sprintDistance, 0);
  return (totalSprints / totalMinutes) * 90; // normalised per 90 min
}

// ─── UCL Penalty ─────────────────────────────────────────────────────────────

function hasRecentUCLAwayTrip(sessions: SessionLoad[], referenceDate: string, withinDays = 5): boolean {
  const window = sessionsInWindow(sessions, referenceDate, withinDays);
  return window.some((s) => s.isEuropeanAway && s.isMidweek);
}

// ─── Risk Zone Classifier ────────────────────────────────────────────────────

function classifyRisk(
  acwr: number,
  sprintDrop: number,
  uclPenalty: boolean
): { zone: RiskZone; confidence: number } {
  let score = 0;
  let maxScore = 0;

  // ACWR contribution
  maxScore += WEIGHTS.acwr;
  if (acwr > WEIGHTS.acwrDangerHigh) {
    score += WEIGHTS.acwr * Math.min((acwr - WEIGHTS.acwrDangerHigh) / 0.5 + 1, 1);
  } else if (acwr < WEIGHTS.acwrDangerLow) {
    score += WEIGHTS.acwr * 0.5;
  }

  // Sprint decay contribution
  maxScore += WEIGHTS.sprintDecay;
  if (sprintDrop > 0) {
    score += WEIGHTS.sprintDecay * Math.min(sprintDrop / 0.3, 1);
  }

  // UCL penalty — boosts score by 12%
  if (uclPenalty) {
    score *= 1 + WEIGHTS.uclTravelDecay;
  }

  const normScore = Math.min(score / maxScore, 1);
  const confidence = 0.75 + normScore * 0.25; // confidence range: 0.75–1.0

  // Red-Zone: sprint drop >15% triggers immediate alert regardless of score
  if (sprintDrop >= WEIGHTS.sprintRedZoneThreshold) {
    return { zone: "RED", confidence };
  }
  if (normScore >= 0.6) return { zone: "RED", confidence };
  if (normScore >= 0.3) return { zone: "AMBER", confidence };
  return { zone: "GREEN", confidence };
}

// ─── Alert Messages ───────────────────────────────────────────────────────────

function buildAlertMessage(
  name: string,
  zone: RiskZone,
  acwr: number,
  sprintDrop: number,
  uclPenalty: boolean
): string {
  const uclNote = uclPenalty ? " [UCL travel decay -12% applied]" : "";
  if (zone === "RED") {
    if (sprintDrop >= WEIGHTS.sprintRedZoneThreshold) {
      return (
        `🔴 RED ZONE — ${name}: Sprint efficiency dropped ${(sprintDrop * 100).toFixed(1)}% below baseline ` +
        `(>${(WEIGHTS.sprintRedZoneThreshold * 100).toFixed(0)}% threshold hit). ACWR: ${acwr.toFixed(2)}.${uclNote} ` +
        `Recommend: rest or reduced-intensity session.`
      );
    }
    return (
      `🔴 RED ZONE — ${name}: High injury/fatigue risk. ACWR: ${acwr.toFixed(2)}, ` +
      `sprint decay: ${(sprintDrop * 100).toFixed(1)}%.${uclNote} Recommend: recovery protocol.`
    );
  }
  if (zone === "AMBER") {
    return (
      `🟡 AMBER ZONE — ${name}: Elevated load. ACWR: ${acwr.toFixed(2)}, ` +
      `sprint decay: ${(sprintDrop * 100).toFixed(1)}%.${uclNote} Monitor closely.`
    );
  }
  return `🟢 GREEN ZONE — ${name}: Load nominal. ACWR: ${acwr.toFixed(2)}.${uclNote}`;
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

export function analysePlayer(
  player: PlayerProfile,
  referenceDate: string = new Date().toISOString().split("T")[0]
): FatigueReport {
  const acwr = calculateACWR(player.sessions, referenceDate);
  const currentSprint = calculateSprintEfficiency(player.sessions, referenceDate, 7);
  const sprintDrop =
    player.baselineSprintEfficiency > 0
      ? Math.max(0, (player.baselineSprintEfficiency - currentSprint) / player.baselineSprintEfficiency)
      : 0;
  const uclPenalty = hasRecentUCLAwayTrip(player.sessions, referenceDate, 5);
  const { zone, confidence } = classifyRisk(acwr, sprintDrop, uclPenalty);

  return {
    playerId: player.id,
    playerName: player.name,
    acwr: parseFloat(acwr.toFixed(3)),
    sprintEfficiency: parseFloat(currentSprint.toFixed(3)),
    sprintEfficiencyDrop: parseFloat(sprintDrop.toFixed(3)),
    uclPenaltyApplied: uclPenalty,
    riskZone: zone,
    alertMessage: buildAlertMessage(player.name, zone, acwr, sprintDrop, uclPenalty),
    confidence: parseFloat(confidence.toFixed(3)),
    timestamp: new Date().toISOString(),
  };
}

export function analyseSquad(
  players: PlayerProfile[],
  referenceDate?: string
): FatigueReport[] {
  return players.map((p) => analysePlayer(p, referenceDate));
}
