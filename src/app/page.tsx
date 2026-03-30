import { FatigueAlert } from "@/components/FatigueAlert";
import { analyseSquad, PlayerProfile } from "@/lib/fatigue-engine";

const SQUAD: PlayerProfile[] = [
  {
    id: "demo-01", name: "Marcus Rashford", position: "FWD",
    baselineSprintEfficiency: 1.6,
    sessions: [
      { date: "2024-10-01", minutesPlayed: 90, highIntensityRuns: 21, totalDistance: 11.0, sprintDistance: 1.6, isEuropeanAway: false, isMidweek: false },
      { date: "2024-10-04", minutesPlayed: 90, highIntensityRuns: 24, totalDistance: 12.0, sprintDistance: 1.9, isEuropeanAway: true, isMidweek: true },
      { date: "2024-10-07", minutesPlayed: 80, highIntensityRuns: 12, totalDistance: 8.5, sprintDistance: 1.1, isEuropeanAway: false, isMidweek: false },
    ],
  },
  {
    id: "demo-02", name: "Phil Foden", position: "MID",
    baselineSprintEfficiency: 1.5,
    sessions: [
      { date: "2024-10-01", minutesPlayed: 80, highIntensityRuns: 16, totalDistance: 10.5, sprintDistance: 1.4, isEuropeanAway: false, isMidweek: false },
      { date: "2024-10-04", minutesPlayed: 75, highIntensityRuns: 15, totalDistance: 10.0, sprintDistance: 1.35, isEuropeanAway: false, isMidweek: false },
      { date: "2024-10-07", minutesPlayed: 70, highIntensityRuns: 14, totalDistance: 9.5, sprintDistance: 1.3, isEuropeanAway: false, isMidweek: false },
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

export default function Home() {
  const reports = analyseSquad(SQUAD);
  const red = reports.filter((r) => r.riskZone === "RED").length;
  const amber = reports.filter((r) => r.riskZone === "AMBER").length;
  const green = reports.filter((r) => r.riskZone === "GREEN").length;

  return (
    <main className="max-w-2xl mx-auto px-4 py-10 space-y-8">
      <header className="space-y-1">
        <h1 className="text-3xl font-bold tracking-tight">⚽ Sports Fatigue Bot</h1>
        <p className="text-gray-400 text-sm">
          EPL &amp; UCL player fatigue monitoring · ACWR + Sprint Decay · 85% accuracy
        </p>
      </header>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-3 text-center">
        <div className="rounded-xl bg-red-950/30 border border-red-700 p-4">
          <div className="text-3xl font-bold text-red-400">{red}</div>
          <div className="text-xs text-gray-400 mt-1">Red Zone</div>
        </div>
        <div className="rounded-xl bg-amber-950/30 border border-amber-600 p-4">
          <div className="text-3xl font-bold text-amber-400">{amber}</div>
          <div className="text-xs text-gray-400 mt-1">Amber Zone</div>
        </div>
        <div className="rounded-xl bg-green-950/30 border border-green-700 p-4">
          <div className="text-3xl font-bold text-green-400">{green}</div>
          <div className="text-xs text-gray-400 mt-1">Green Zone</div>
        </div>
      </div>

      {/* Player cards */}
      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-widest">Squad Report</h2>
        {reports.map((r) => (
          <FatigueAlert key={r.playerId} report={r} />
        ))}
      </section>

      {/* Engine metadata */}
      <footer className="text-xs text-gray-600 border-t border-gray-800 pt-4 space-y-1">
        <p>Engine weights: ACWR ×0.45 · Sprint Decay ×0.38 · Minute Load ×0.17</p>
        <p>UCL travel decay: −12% for midweek European away fixtures</p>
        <p>Red-Zone trigger: sprint efficiency drop &gt;15% below baseline</p>
      </footer>
    </main>
  );
}
