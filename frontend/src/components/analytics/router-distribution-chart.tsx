"use client";

import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { GlassCard } from "@/components/ui/glass-card";
import type { SwapRecord } from "@/hooks/useAnalyticsHistory";
import { labelRouter } from "@/lib/contract";

const COLORS = ["#d4af37", "#f1d68c", "#a9791b", "#8a6d1f", "#e5c158", "#c19b2e", "#7a5f19"];

export function RouterDistributionChart({ swaps }: { swaps: SwapRecord[] }) {
  const byRouter = new Map<string, number>();
  for (const s of swaps) {
    const label = labelRouter(s.router);
    byRouter.set(label, (byRouter.get(label) ?? 0) + 1);
  }
  const data = Array.from(byRouter.entries()).map(([name, value]) => ({ name, value }));

  return (
    <GlassCard>
      <h3 className="font-medium mb-1">Swap Volume by Router</h3>
      <p className="text-xs text-muted mb-4">Count of SwapExecuted events per router in the scanned window.</p>
      {data.length === 0 ? (
        <p className="text-sm text-muted">No swaps recorded in the scanned window.</p>
      ) : (
        <ResponsiveContainer width="100%" height={240}>
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" innerRadius={50} outerRadius={80} paddingAngle={2}>
              {data.map((_, i) => (
                <Cell key={i} fill={COLORS[i % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip contentStyle={{ background: "#14151a", border: "1px solid rgba(212,175,55,0.2)", borderRadius: 8 }} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
          </PieChart>
        </ResponsiveContainer>
      )}
    </GlassCard>
  );
}
