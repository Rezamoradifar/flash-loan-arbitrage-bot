"use client";

import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { formatUnits as viemFormatUnits } from "viem";
import { GlassCard } from "@/components/ui/glass-card";
import type { ExecutionRecord } from "@/hooks/useAnalyticsHistory";

export function GasChart({ executions }: { executions: ExecutionRecord[] }) {
  const data = executions
    .filter((e) => e.gasUsed !== null)
    .sort((a, b) => Number(a.blockNumber - b.blockNumber))
    .map((e, i) => ({
      label: `#${i + 1}`,
      gasBnb: Number(viemFormatUnits(e.gasUsed ?? 0n, 18)),
    }));

  return (
    <GlassCard>
      <h3 className="font-medium mb-1">Gas Cost per Execution</h3>
      <p className="text-xs text-muted mb-4">Actual gasUsed × effectiveGasPrice from each execution&apos;s transaction receipt, in BNB.</p>
      {data.length === 0 ? (
        <p className="text-sm text-muted">No transaction receipts resolved yet.</p>
      ) : (
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis dataKey="label" stroke="#8a8a94" fontSize={11} />
            <YAxis stroke="#8a8a94" fontSize={11} width={70} />
            <Tooltip contentStyle={{ background: "#14151a", border: "1px solid rgba(212,175,55,0.2)", borderRadius: 8 }} />
            <Line type="monotone" dataKey="gasBnb" stroke="#d4af37" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      )}
    </GlassCard>
  );
}
