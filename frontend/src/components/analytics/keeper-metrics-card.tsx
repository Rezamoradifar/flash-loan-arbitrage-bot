"use client";

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { GlassCard, StatCard } from "@/components/ui/glass-card";
import { useKeeperMetrics } from "@/hooks/useKeeperApi";
import { KEEPER_API_URL } from "@/lib/contract";

interface MetricsSnapshot {
  evaluated: number;
  accepted: number;
  rejected: number;
  rejectedByReason: Record<string, number>;
  scanCount: number;
  lastScanMs: number;
}

export function KeeperMetricsCard() {
  const { data, isLoading, isError } = useKeeperMetrics();
  const snapshot = data as unknown as MetricsSnapshot | undefined;

  if (!KEEPER_API_URL) {
    return (
      <GlassCard>
        <h3 className="font-medium mb-1">Scanner Evaluation Metrics</h3>
        <p className="text-sm text-muted">
          Keeper API not configured - set NEXT_PUBLIC_KEEPER_API_URL to see real evaluated/accepted/rejected counts
          from the scanner.
        </p>
      </GlassCard>
    );
  }

  if (isLoading) return <GlassCard><p className="text-sm text-muted">Loading keeper metrics...</p></GlassCard>;
  if (isError || !snapshot || snapshot.evaluated === undefined) {
    return <GlassCard><p className="text-sm text-danger">Keeper metrics unreachable.</p></GlassCard>;
  }

  const successRate = snapshot.evaluated > 0 ? ((snapshot.accepted / snapshot.evaluated) * 100).toFixed(1) : "0.0";
  const reasonData = Object.entries(snapshot.rejectedByReason ?? {}).map(([reason, count]) => ({ reason, count }));

  return (
    <GlassCard className="lg:col-span-2">
      <h3 className="font-medium mb-1">Scanner Evaluation Metrics</h3>
      <p className="text-xs text-muted mb-4">
        Real counts from the keeper&apos;s own scan loop - every candidate route it evaluates is counted here,
        accepted or rejected, with the rejection reason.
      </p>
      <div className="grid grid-cols-2 gap-3 mb-4 sm:grid-cols-4">
        <StatCard label="Evaluated" value={snapshot.evaluated} />
        <StatCard label="Accepted" value={snapshot.accepted} />
        <StatCard label="Rejected" value={snapshot.rejected} />
        <StatCard label="Acceptance Rate" value={`${successRate}%`} />
      </div>
      {reasonData.length > 0 && (
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={reasonData} layout="vertical" margin={{ left: 24 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis type="number" stroke="#8a8a94" fontSize={11} allowDecimals={false} />
            <YAxis dataKey="reason" type="category" stroke="#8a8a94" fontSize={11} width={140} />
            <Tooltip contentStyle={{ background: "#14151a", border: "1px solid rgba(212,175,55,0.2)", borderRadius: 8 }} />
            <Bar dataKey="count" radius={[0, 6, 6, 0]}>
              {reasonData.map((_, i) => (
                <Cell key={i} fill={i % 2 === 0 ? "#d4af37" : "#a9791b"} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </GlassCard>
  );
}
