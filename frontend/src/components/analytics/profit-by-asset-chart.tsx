"use client";

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { GlassCard } from "@/components/ui/glass-card";
import type { ExecutionRecord } from "@/hooks/useAnalyticsHistory";
import { formatUnits } from "@/lib/utils";

const COLORS = ["#d4af37", "#f1d68c", "#a9791b", "#8a6d1f", "#e5c158", "#c19b2e"];

export function ProfitByAssetChart({ executions }: { executions: ExecutionRecord[] }) {
  const byAsset = new Map<string, bigint>();
  for (const e of executions) {
    byAsset.set(e.assetSymbol, (byAsset.get(e.assetSymbol) ?? 0n) + e.netProfit);
  }
  const data = Array.from(byAsset.entries()).map(([symbol, profit]) => ({
    symbol,
    profit: Number(formatUnits(profit, 18, 6).replace(/,/g, "")),
  }));

  return (
    <GlassCard>
      <h3 className="font-medium mb-1">Net Profit by Asset</h3>
      <p className="text-xs text-muted mb-4">Summed from on-chain ArbitrageExecuted.netProfit - each asset is a separate unit, not combined into one total.</p>
      {data.length === 0 ? (
        <p className="text-sm text-muted">No realized executions in the scanned window.</p>
      ) : (
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis dataKey="symbol" stroke="#8a8a94" fontSize={11} />
            <YAxis stroke="#8a8a94" fontSize={11} />
            <Tooltip contentStyle={{ background: "#14151a", border: "1px solid rgba(212,175,55,0.2)", borderRadius: 8 }} />
            <Bar dataKey="profit" radius={[6, 6, 0, 0]}>
              {data.map((_, i) => (
                <Cell key={i} fill={COLORS[i % COLORS.length]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </GlassCard>
  );
}
