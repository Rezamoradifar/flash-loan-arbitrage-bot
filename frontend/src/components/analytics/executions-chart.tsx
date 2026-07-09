"use client";

import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { GlassCard } from "@/components/ui/glass-card";
import type { ExecutionRecord } from "@/hooks/useAnalyticsHistory";

function bucketByDay(executions: ExecutionRecord[]) {
  const buckets = new Map<string, number>();
  for (const e of executions) {
    if (!e.timestamp) continue;
    const day = new Date(e.timestamp).toISOString().slice(0, 10);
    buckets.set(day, (buckets.get(day) ?? 0) + 1);
  }
  return Array.from(buckets.entries())
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, count]) => ({ date, executions: count }));
}

export function ExecutionsChart({ executions }: { executions: ExecutionRecord[] }) {
  const data = bucketByDay(executions);
  return (
    <GlassCard>
      <h3 className="font-medium mb-4">Executions Over Time</h3>
      {data.length === 0 ? (
        <p className="text-sm text-muted">No executions with resolvable timestamps in the scanned window.</p>
      ) : (
        <ResponsiveContainer width="100%" height={240}>
          <AreaChart data={data}>
            <defs>
              <linearGradient id="execGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#d4af37" stopOpacity={0.5} />
                <stop offset="95%" stopColor="#d4af37" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis dataKey="date" stroke="#8a8a94" fontSize={11} />
            <YAxis stroke="#8a8a94" fontSize={11} allowDecimals={false} />
            <Tooltip contentStyle={{ background: "#14151a", border: "1px solid rgba(212,175,55,0.2)", borderRadius: 8 }} />
            <Area type="monotone" dataKey="executions" stroke="#d4af37" fill="url(#execGradient)" strokeWidth={2} />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </GlassCard>
  );
}
