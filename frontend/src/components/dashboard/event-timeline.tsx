"use client";

import {
  Zap,
  RefreshCw,
  ArrowLeftRight,
  TrendingUp,
  Play,
  Router,
  Coins,
  Key,
  AlertTriangle,
  Banknote,
  Wallet,
  ExternalLink,
} from "lucide-react";
import { GlassCard } from "@/components/ui/glass-card";
import { useContractEvents, type TimelineEvent } from "@/hooks/useContractEvents";
import { labelAsset, BSCSCAN_TX_URL } from "@/lib/contract";
import { formatUnits, shortenAddress } from "@/lib/utils";
import type { TrackedEventName } from "@/lib/eventNames";

const ICONS: Record<TrackedEventName, React.ComponentType<{ size?: number; className?: string }>> = {
  FlashLoanStarted: Zap,
  FlashLoanRepaid: RefreshCw,
  SwapExecuted: ArrowLeftRight,
  ProfitRealized: TrendingUp,
  ArbitrageExecuted: Play,
  RouterUpdated: Router,
  AssetUpdated: Coins,
  KeeperUpdated: Key,
  EmergencyAction: AlertTriangle,
  WithdrawalRequested: Banknote,
  ProfitWithdrawn: Wallet,
};

function describe(event: TimelineEvent): string {
  const a = event.args;
  switch (event.name) {
    case "FlashLoanStarted":
      return `Flash loan started: ${formatUnits(a.amount as bigint, 18, 4)} ${labelAsset(a.asset as string)}`;
    case "FlashLoanRepaid":
      return `Flash loan repaid: ${formatUnits(a.amount as bigint, 18, 4)} ${labelAsset(a.asset as string)} (premium ${formatUnits((a.premium as bigint) ?? 0n, 18, 4)})`;
    case "SwapExecuted":
      return `Swap on ${shortenAddress(a.router as string)}: ${labelAsset(a.tokenIn as string)} → ${labelAsset((a.tokenOut as string) ?? "")}`;
    case "ProfitRealized":
      return `Profit realized: ${formatUnits(a.amount as bigint, 18, 4)} ${labelAsset(a.asset as string)}`;
    case "ArbitrageExecuted":
      return `Arbitrage executed on ${labelAsset(a.asset as string)}, borrowed ${formatUnits((a.amountBorrowed as bigint) ?? 0n, 18, 4)}`;
    case "RouterUpdated":
      return `Router ${shortenAddress(a.router as string)} ${a.allowed ? "whitelisted" : "removed"}`;
    case "AssetUpdated":
      return `Asset ${labelAsset(a.asset as string)} ${a.allowed ? "whitelisted" : "removed"}`;
    case "KeeperUpdated":
      return `Keeper updated to ${shortenAddress(a.newKeeper as string)}`;
    case "EmergencyAction":
      return `Emergency action: ${a.action} by ${shortenAddress(a.actor as string)}`;
    case "WithdrawalRequested":
      return `Withdrawal requested for ${labelAsset(a.token as string)}`;
    case "ProfitWithdrawn":
      return `Profit withdrawn: ${labelAsset(a.token as string)}`;
    default:
      return event.name;
  }
}

export function EventTimeline({ limit }: { limit?: number }) {
  const { events, loading, error } = useContractEvents();
  const shown = limit ? events.slice(0, limit) : events;

  return (
    <GlassCard>
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-medium">Live Event Timeline</h3>
        {!loading && <span className="text-xs text-muted">{events.length} event(s)</span>}
      </div>

      {loading && <p className="text-sm text-muted">Loading on-chain history...</p>}
      {error && <p className="text-sm text-danger">Failed to load events: {error}</p>}
      {!loading && !error && shown.length === 0 && (
        <p className="text-sm text-muted">No events emitted yet in the scanned block range.</p>
      )}

      <ol className="flex flex-col gap-3 max-h-[480px] overflow-y-auto pr-1">
        {shown.map((event) => {
          const Icon = ICONS[event.name];
          return (
            <li key={event.id} className="flex items-start gap-3 border-b border-white/5 pb-3 last:border-none">
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gold/10 text-gold">
                <Icon size={15} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm">{describe(event)}</p>
                <div className="mt-1 flex items-center gap-2 text-[11px] text-muted">
                  <span>Block {event.blockNumber.toString()}</span>
                  <span>·</span>
                  <a
                    href={BSCSCAN_TX_URL(event.transactionHash)}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 hover:text-gold"
                  >
                    {shortenAddress(event.transactionHash)} <ExternalLink size={10} />
                  </a>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </GlassCard>
  );
}
