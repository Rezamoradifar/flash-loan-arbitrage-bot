"use client";

import { useAccount, useBalance } from "wagmi";
import { formatUnits as viemFormatUnits } from "viem";
import { Wallet } from "lucide-react";
import { GlassCard } from "@/components/ui/glass-card";
import { shortenAddress } from "@/lib/utils";

export function WalletCard() {
  const { address, isConnected, chain } = useAccount();
  const { data: balance } = useBalance({ address });

  return (
    <GlassCard>
      <div className="flex items-center gap-2 mb-4">
        <Wallet size={16} className="text-gold" />
        <h3 className="font-medium">Your Wallet</h3>
      </div>
      {isConnected && address ? (
        <div className="flex flex-col gap-2 text-sm">
          <Row label="Address" value={shortenAddress(address, 6)} />
          <Row label="Balance" value={balance ? `${viemFormatUnits(balance.value, balance.decimals).slice(0, 8)} ${balance.symbol}` : "—"} />
          <Row label="Network" value={chain?.name ?? "Unknown"} highlight={chain?.id !== 56} />
        </div>
      ) : (
        <p className="text-sm text-muted">Connect a wallet to view balance and owner-only controls.</p>
      )}
    </GlassCard>
  );
}

function Row({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted">{label}</span>
      <span className={highlight ? "text-danger font-medium" : "font-medium"}>{value}</span>
    </div>
  );
}
