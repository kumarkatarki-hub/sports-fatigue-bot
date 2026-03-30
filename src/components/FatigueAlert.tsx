import { FatigueReport } from "@/lib/fatigue-engine";

const zoneStyles: Record<string, string> = {
  RED: "border-red-600 bg-red-950/40",
  AMBER: "border-amber-500 bg-amber-950/40",
  GREEN: "border-green-600 bg-green-950/40",
};

const zoneIcon: Record<string, string> = {
  RED: "🔴",
  AMBER: "🟡",
  GREEN: "🟢",
};

export function FatigueAlert({ report }: { report: FatigueReport }) {
  const style = zoneStyles[report.riskZone] ?? zoneStyles.GREEN;
  const icon = zoneIcon[report.riskZone] ?? "🟢";

  return (
    <div className={`rounded-xl border ${style} p-4 space-y-2`}>
      <div className="flex items-center justify-between">
        <span className="font-bold text-lg">
          {icon} {report.playerName}
        </span>
        <span className="text-xs text-gray-400">
          {(report.confidence * 100).toFixed(0)}% confidence
        </span>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm text-gray-300">
        <div>ACWR: <span className="font-mono text-white">{report.acwr}</span></div>
        <div>Sprint Eff: <span className="font-mono text-white">{report.sprintEfficiency} km/90</span></div>
        <div>Sprint Drop: <span className="font-mono text-white">{(report.sprintEfficiencyDrop * 100).toFixed(1)}%</span></div>
        <div>UCL Penalty: <span className="font-mono text-white">{report.uclPenaltyApplied ? "⚠️ Yes" : "No"}</span></div>
      </div>
      <p className="text-xs text-gray-400 pt-1 border-t border-gray-700">{report.alertMessage}</p>
    </div>
  );
}
