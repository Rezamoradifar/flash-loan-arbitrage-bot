"use client";

import { ExternalLink, ListOrdered } from "lucide-react";
import { formatUnits as viemFormatUnits } from "viem";
import { useAnalyticsHistory } from "@/hooks/useAnalyticsHistory";
import { GlassCard } from "@/components/ui/glass-card";
import { BSCSCAN_TX_URL } from "@/lib/contract";
import { formatUnits, shortenAddress } from "@/lib/utils";

export default function TransactionsPage() {
  const { executions, loading, error } = useAnalyticsHistory();
  const sorted = [...executions].sort((a, b) => Number(b.blockNumber - a.blockNumber));

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 py-10">
      <div className="flex items-center gap-2 mb-1">
        <ListOrdered size={20} className="text-gold" />
        <h1 className="text-2xl font-semibold">Transactions</h1>
      </div>
      <p className="text-sm text-muted mb-8">
        Every confirmed ArbitrageExecuted transaction in the scanned block window, read directly from on-chain
        logs and linked to BscScan.
      </p>

      {loading && <p className="text-sm text-muted mb-4">Scanning recent block history...</p>}
      {error && <p className="text-sm text-danger mb-4">Failed to load history: {error}</p>}

      <GlassCard className="p-0 overflow-hidden">
        {sorted.length === 0 ? (
          <p className="text-sm text-muted p-6">No executions found in the scanned window.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-muted border-b border-white/5">
                  <th className="px-4 py-3 font-normal">Tx Hash</th>
                  <th className="px-4 py-3 font-normal">Status</th>
                  <th className="px-4 py-3 font-normal">Asset</th>
                  <th className="px-4 py-3 font-normal text-right">Amount Borrowed</th>
                  <th className="px-4 py-3 font-normal text-right">Net Profit</th>
                  <th className="px-4 py-3 font-normal text-right">Gas Cost (BNB)</th>
                  <th className="px-4 py-3 font-normal text-right">Block</th>
                  <th className="px-4 py-3 font-normal text-right">Time</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((e) => (
                  <tr key={e.txHash} className="border-b border-white/5 last:border-none hover:bg-white/[0.02]">
                    <td className="px-4 py-3">
                      <a
                        href={BSCSCAN_TX_URL(e.txHash)}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-1 font-mono text-xs text-gold hover:underline"
                      >
                        {shortenAddress(e.txHash)} <ExternalLink size={10} />
                      </a>
                    </td>
                    <td className="px-4 py-3">
                      <span className="rounded-full bg-success/10 px-2 py-0.5 text-xs text-success">Confirmed</span>
                    </td>
                    <td className="px-4 py-3">{e.assetSymbol}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{formatUnits(e.amountBorrowed, 18, 4)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{formatUnits(e.netProfit, 18, 4)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {e.gasUsed !== null ? Number(viemFormatUnits(e.gasUsed, 18)).toFixed(6) : "—"}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{e.blockNumber.toString()}</td>
                    <td className="px-4 py-3 text-right text-xs text-muted">
                      {e.timestamp ? new Date(e.timestamp).toLocaleString() : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </GlassCard>
    </div>
  );
}
