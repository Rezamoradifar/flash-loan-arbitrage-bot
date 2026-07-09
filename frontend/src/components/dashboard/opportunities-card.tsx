"use client";

import { TrendingUp, TrendingDown, ListChecks } from "lucide-react";
import { GlassCard } from "@/components/ui/glass-card";
import { useKeeperOpportunities } from "@/hooks/useKeeperApi";
import { KEEPER_API_URL } from "@/lib/contract";
import { formatUnits, timeAgo } from "@/lib/utils";

export function OpportunitiesCard() {
  const { data, isLoading, isError } = useKeeperOpportunities();

  return (
    <GlassCard className="lg:col-span-2">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <ListChecks size={16} className="text-gold" />
          <h3 className="font-medium">Live Opportunities</h3>
        </div>
        {data?.lastScanAt && (
          <span className="text-xs text-muted">
            scanned {timeAgo(data.lastScanAt)} ({data.durationMs}ms)
          </span>
        )}
      </div>

      {!KEEPER_API_URL ? (
        <p className="text-sm text-muted">Keeper API not configured - set NEXT_PUBLIC_KEEPER_API_URL to see live scan results.</p>
      ) : isLoading ? (
        <p className="text-sm text-muted">Loading scan results...</p>
      ) : isError || !data ? (
        <p className="text-sm text-danger">Keeper unreachable.</p>
      ) : data.opportunities.length === 0 ? (
        <p className="text-sm text-muted">No candidate routes in the most recent scan cycle.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-muted">
                <th className="pb-2 font-normal">Route</th>
                <th className="pb-2 font-normal">Asset</th>
                <th className="pb-2 font-normal text-right">Net Profit</th>
                <th className="pb-2 font-normal text-right">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.opportunities.slice(0, 8).map((o) => {
                const positive = !o.netProfit.startsWith("-");
                return (
                  <tr key={o.name} className="border-t border-white/5">
                    <td className="py-2 pr-2">{o.name}</td>
                    <td className="py-2 pr-2">{o.baseAsset.symbol}</td>
                    <td className="py-2 pr-2 text-right tabular-nums flex items-center justify-end gap-1">
                      {positive ? <TrendingUp size={12} className="text-success" /> : <TrendingDown size={12} className="text-danger" />}
                      {formatUnits(BigInt(o.netProfit), o.baseAsset.decimals, 4)}
                    </td>
                    <td className="py-2 text-right">
                      <span
                        className={
                          o.executable
                            ? "rounded-full bg-success/10 px-2 py-0.5 text-xs text-success"
                            : "rounded-full bg-white/5 px-2 py-0.5 text-xs text-muted"
                        }
                      >
                        {o.executable ? "Executable" : "Rejected"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </GlassCard>
  );
}
