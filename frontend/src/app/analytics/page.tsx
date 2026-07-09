"use client";

import { BarChart3 } from "lucide-react";
import { useAnalyticsHistory } from "@/hooks/useAnalyticsHistory";
import { ExecutionsChart } from "@/components/analytics/executions-chart";
import { ProfitByAssetChart } from "@/components/analytics/profit-by-asset-chart";
import { RouterDistributionChart } from "@/components/analytics/router-distribution-chart";
import { GasChart } from "@/components/analytics/gas-chart";
import { KeeperMetricsCard } from "@/components/analytics/keeper-metrics-card";
import { StatCard } from "@/components/ui/glass-card";

export default function AnalyticsPage() {
  const { executions, swaps, flashLoanCount, loading, error } = useAnalyticsHistory();

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 py-10">
      <div className="flex items-center gap-2 mb-1">
        <BarChart3 size={20} className="text-gold" />
        <h1 className="text-2xl font-semibold">Analytics</h1>
      </div>
      <p className="text-sm text-muted mb-8">
        Derived entirely from on-chain event logs and the keeper&apos;s own scan metrics - no simulated or
        placeholder figures.
      </p>

      {loading && <p className="text-sm text-muted mb-6">Scanning recent block history...</p>}
      {error && <p className="text-sm text-danger mb-6">Failed to load on-chain history: {error}</p>}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 mb-6">
        <StatCard label="Executions Scanned" value={executions.length} />
        <StatCard label="Flash Loans Started" value={flashLoanCount} />
        <StatCard label="Swaps Recorded" value={swaps.length} />
        <StatCard label="Distinct Assets" value={new Set(executions.map((e) => e.assetSymbol)).size} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2 mb-4">
        <ExecutionsChart executions={executions} />
        <ProfitByAssetChart executions={executions} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2 mb-4">
        <RouterDistributionChart swaps={swaps} />
        <GasChart executions={executions} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <KeeperMetricsCard />
      </div>
    </div>
  );
}
