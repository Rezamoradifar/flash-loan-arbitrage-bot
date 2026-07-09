"use client";

import { useReadContract } from "wagmi";
import { GlassCard } from "@/components/ui/glass-card";
import { CONTRACT_ADDRESS } from "@/lib/contract";
import { EXECUTOR_ABI } from "@/lib/executorAbi";
import { shortenAddress } from "@/lib/utils";

const reads = [
  "owner",
  "pendingOwner",
  "keeper",
  "feeRecipient",
  "profitRecipient",
  "protocolFeeBPS",
  "minProfitThreshold",
  "minSpreadBPS",
  "defaultSlippageBPS",
  "deadlineWindow",
  "maxFlashLoanAmount",
  "maxOracleDeviationBPS",
  "maxOracleStaleness",
  "estimatedGasUnits",
  "paused",
] as const;

function useAllConfig() {
  const results: Partial<Record<(typeof reads)[number], unknown>> = {};
  // Individual hooks (not array-based useReadContracts) so each keeps a
  // simple, shallow type - safe to call a fixed, known-length list of hooks.
  for (const fn of reads) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const { data } = useReadContract({ address: CONTRACT_ADDRESS, abi: EXECUTOR_ABI, functionName: fn });
    results[fn] = data;
  }
  return results;
}

function fmt(v: unknown): string {
  if (v === undefined || v === null) return "—";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string" && v.startsWith("0x") && v.length === 42) return shortenAddress(v, 6);
  return String(v);
}

export function CurrentConfigCard() {
  const cfg = useAllConfig();
  return (
    <GlassCard>
      <h3 className="font-medium mb-4">Current On-Chain Configuration</h3>
      <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3 text-sm">
        {reads.map((fn) => (
          <div key={fn} className="flex items-center justify-between border-b border-white/5 pb-1.5">
            <span className="text-muted text-xs">{fn}</span>
            <span className="font-mono text-xs">{fmt(cfg[fn])}</span>
          </div>
        ))}
      </div>
    </GlassCard>
  );
}
