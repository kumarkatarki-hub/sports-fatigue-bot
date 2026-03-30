import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// ─── Schema helpers ───────────────────────────────────────────────────────────

export interface DbFatigueReport {
  id?: string;
  player_id: string;
  player_name: string;
  acwr: number;
  sprint_efficiency: number;
  sprint_efficiency_drop: number;
  ucl_penalty: boolean;
  risk_zone: "RED" | "AMBER" | "GREEN";
  alert_message: string;
  confidence: number;
  created_at?: string;
}

export interface DbPayment {
  id?: string;
  telegram_user_id: number;
  stars_amount: number;
  feature: string;
  telegram_charge_id: string;
  created_at?: string;
}

export async function saveReport(report: DbFatigueReport) {
  const { data, error } = await supabase
    .from("fatigue_reports")
    .insert(report)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function getRecentReports(limit = 20) {
  const { data, error } = await supabase
    .from("fatigue_reports")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data as DbFatigueReport[];
}

export async function savePayment(payment: DbPayment) {
  const { data, error } = await supabase
    .from("payments")
    .insert(payment)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function hasUserPaid(telegramUserId: number, feature: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("payments")
    .select("id")
    .eq("telegram_user_id", telegramUserId)
    .eq("feature", feature)
    .limit(1);
  if (error) return false;
  return (data?.length ?? 0) > 0;
}

// ─── Players ──────────────────────────────────────────────────────────────────

export interface DbPlayer {
  id?: string;
  external_id: string;
  name: string;
  position: "GK" | "DEF" | "MID" | "FWD";
  team: string;
  league: string;
  baseline_sprint: number;
  created_at?: string;
  updated_at?: string;
}

export async function upsertPlayer(player: DbPlayer) {
  const { data, error } = await supabase
    .from("players")
    .upsert({ ...player, updated_at: new Date().toISOString() }, { onConflict: "external_id" })
    .select()
    .single();
  if (error) throw error;
  return data as DbPlayer;
}

export async function getPlayers(league?: string) {
  let q = supabase.from("players").select("*").order("name");
  if (league) q = q.eq("league", league);
  const { data, error } = await q;
  if (error) throw error;
  return data as DbPlayer[];
}

// ─── Match Stats ──────────────────────────────────────────────────────────────

export interface DbMatchStat {
  id?: string;
  player_id: string;
  match_date: string;
  minutes_played: number;
  total_distance: number;
  sprint_distance: number;
  high_intensity_runs: number;
  is_european_away: boolean;
  is_midweek: boolean;
  opponent?: string;
  created_at?: string;
}

export async function saveMatchStat(stat: DbMatchStat) {
  const { data, error } = await supabase
    .from("match_stats")
    .insert(stat)
    .select()
    .single();
  if (error) throw error;
  return data as DbMatchStat;
}

export async function getPlayerStats(playerId: string, limit = 28) {
  const { data, error } = await supabase
    .from("match_stats")
    .select("*")
    .eq("player_id", playerId)
    .order("match_date", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data as DbMatchStat[];
}

// ─── Alerts ───────────────────────────────────────────────────────────────────

export interface DbAlert {
  id?: string;
  player_id: string;
  risk_zone: "RED" | "AMBER" | "GREEN";
  acwr: number;
  sprint_drop: number;
  ucl_penalty: boolean;
  message: string;
  confidence: number;
  acknowledged?: boolean;
  created_at?: string;
}

export async function saveAlert(alert: DbAlert) {
  const { data, error } = await supabase
    .from("alerts")
    .insert(alert)
    .select()
    .single();
  if (error) throw error;
  return data as DbAlert;
}

export async function getOpenAlerts(zone?: "RED" | "AMBER") {
  let q = supabase
    .from("alerts")
    .select("*, players(name, team)")
    .eq("acknowledged", false)
    .order("created_at", { ascending: false });
  if (zone) q = q.eq("risk_zone", zone);
  const { data, error } = await q;
  if (error) throw error;
  return data;
}

export async function acknowledgeAlert(alertId: string) {
  const { error } = await supabase
    .from("alerts")
    .update({ acknowledged: true })
    .eq("id", alertId);
  if (error) throw error;
}

// ─── Subscriptions ────────────────────────────────────────────────────────────

export type SubPlan = "single_report" | "matchday_pass" | "medical_pro";

export interface DbSubscription {
  id?: string;
  telegram_user_id: number;
  plan: SubPlan;
  stars_paid: number;
  telegram_charge_id: string;
  expires_at?: string | null;
  used_at?: string | null;
  created_at?: string;
}

/** Call immediately after successful_payment to activate access */
export async function createSubscription(sub: DbSubscription) {
  const { data, error } = await supabase
    .from("subscriptions")
    .insert(sub)
    .select()
    .single();
  if (error) throw error;
  return data as DbSubscription;
}

/**
 * Returns the first active subscription for a user, or null.
 * Active = not expired AND (not single_report OR not yet used).
 */
export async function getActiveSubscription(
  telegramUserId: number
): Promise<DbSubscription | null> {
  const now = new Date().toISOString();

  // 1. Check time-based plans (matchday_pass, medical_pro) — not expired
  const { data: timeBased } = await supabase
    .from("subscriptions")
    .select("*")
    .eq("telegram_user_id", telegramUserId)
    .in("plan", ["matchday_pass", "medical_pro"])
    .gt("expires_at", now)
    .order("expires_at", { ascending: false })
    .limit(1);

  if (timeBased?.length) return timeBased[0] as DbSubscription;

  // 2. Check single_report — unused
  const { data: single } = await supabase
    .from("subscriptions")
    .select("*")
    .eq("telegram_user_id", telegramUserId)
    .eq("plan", "single_report")
    .is("used_at", null)
    .order("created_at", { ascending: false })
    .limit(1);

  if (single?.length) return single[0] as DbSubscription;

  return null;
}

/** Mark a single_report as consumed after delivery */
export async function consumeSingleReport(subscriptionId: string) {
  const { error } = await supabase
    .from("subscriptions")
    .update({ used_at: new Date().toISOString() })
    .eq("id", subscriptionId)
    .eq("plan", "single_report");
  if (error) throw error;
}

// ─── Telegram Subscribers ─────────────────────────────────────────────────────

export interface DbSubscriber {
  id?: string;
  telegram_user_id: number;
  chat_id: number;
  username?: string;
  is_active?: boolean;
  created_at?: string;
  last_seen_at?: string;
}

/** Upsert subscriber when they /start the bot */
export async function upsertSubscriber(sub: DbSubscriber) {
  const { error } = await supabase
    .from("telegram_subscribers")
    .upsert(
      { ...sub, is_active: true, last_seen_at: new Date().toISOString() },
      { onConflict: "telegram_user_id" }
    );
  if (error) throw error;
}

/** Get all active subscribers (for broadcast) */
export async function getAllSubscribers(): Promise<DbSubscriber[]> {
  const { data, error } = await supabase
    .from("telegram_subscribers")
    .select("chat_id, telegram_user_id, username")
    .eq("is_active", true);
  if (error) throw error;
  return (data ?? []) as DbSubscriber[];
}

/** Get subscribers who have paid for a specific feature (two-step query) */
export async function getPaidSubscribers(feature: string): Promise<DbSubscriber[]> {
  // Step 1: get all user IDs that paid for this feature
  const { data: payData } = await supabase
    .from("payments")
    .select("telegram_user_id")
    .eq("feature", feature);
  if (!payData?.length) return [];

  const ids = payData.map((p: { telegram_user_id: number }) => p.telegram_user_id);

  // Step 2: get active subscribers matching those IDs
  const { data: subs, error } = await supabase
    .from("telegram_subscribers")
    .select("chat_id, telegram_user_id, username")
    .eq("is_active", true)
    .in("telegram_user_id", ids);
  if (error) throw error;
  return (subs ?? []) as DbSubscriber[];
}
