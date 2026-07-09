"use client";

import { Activity, Blocks, Coins, Fuel, ShieldCheck, Zap } from "lucide-react";
import { formatUnits as viemFormatUnits } from "viem";
import { useAccount, useBalance } from "wagmi";
import { StatCard } from "@/components/ui/glass-card";
import { useContractStats } from "@/hooks/useContractStats";
import { formatUnits } from "@/lib/utils";
import { useLocale } from "@/components/locale-provider";

export function LiveStats() {
  const { t } = useLocale();
  const { totalFlashLoans, totalOperations, balanceByAsset, blockNumber, gasPrice, paused, isLoading } =
    useContractStats();
  const { address, isConnected } = useAccount();
  const { data: walletBalance } = useBalance({ address });

  const nonZeroAssets = balanceByAsset.filter((a) => a.balance > 0n);

  return (
    <section className="mx-auto max-w-7xl px-4 sm:px-6 py-16">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
        <StatCard
          label={t("stats.balance")}
          icon={<Coins size={16} />}
          value={isLoading ? "…" : nonZeroAssets.length === 0 ? "0.00" : `${nonZeroAssets.length} asset(s)`}
          hint={
            nonZeroAssets.length > 0
              ? nonZeroAssets.map((a) => `${formatUnits(a.balance, a.decimals, 2)} ${a.symbol}`).join(" · ")
              : "Flash-loan-only contract - no idle balance is expected"
          }
        />
        <StatCard
          label={t("stats.flashloans")}
          icon={<Zap size={16} />}
          value={isLoading ? "…" : totalFlashLoans !== undefined ? totalFlashLoans.toString() : "—"}
        />
        <StatCard
          label={t("stats.operations")}
          icon={<Activity size={16} />}
          value={isLoading ? "…" : totalOperations !== undefined ? totalOperations.toString() : "—"}
        />
        <StatCard
          label={t("stats.gas")}
          icon={<Fuel size={16} />}
          value={gasPrice ? `${viemFormatUnits(gasPrice, 9)} gwei` : "—"}
        />
        <StatCard
          label={t("stats.block")}
          icon={<Blocks size={16} />}
          value={blockNumber ? blockNumber.toString() : "—"}
        />
        <StatCard
          label={t("stats.network")}
          icon={<ShieldCheck size={16} />}
          value={paused ? "Paused" : "Active"}
          hint={paused ? "Emergency pause is engaged" : "Contract accepting arbitrage execution"}
        />
        <StatCard
          label="Connected Wallet"
          value={isConnected ? "Connected" : "Not Connected"}
          hint={walletBalance ? `${viemFormatUnits(walletBalance.value, 18).slice(0, 8)} BNB` : undefined}
        />
        <StatCard label={t("stats.profit")} value="See Analytics" hint="Per-asset breakdown avoids mixing decimals across tokens" />
      </div>
    </section>
  );
}
