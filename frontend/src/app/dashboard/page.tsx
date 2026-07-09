import { WalletCard } from "@/components/dashboard/wallet-card";
import { ContractInfoCard } from "@/components/dashboard/contract-info-card";
import { KeeperStatusCard } from "@/components/dashboard/keeper-status-card";
import { OpportunitiesCard } from "@/components/dashboard/opportunities-card";
import { EventTimeline } from "@/components/dashboard/event-timeline";
import { LiveStats } from "@/components/landing/live-stats";

export default function DashboardPage() {
  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 py-10">
      <h1 className="text-2xl font-semibold mb-1">Dashboard</h1>
      <p className="text-sm text-muted mb-8">Real-time contract, wallet, and keeper status - all reads are live on-chain calls.</p>

      <LiveStats />

      <div className="grid gap-4 lg:grid-cols-3 mb-4">
        <WalletCard />
        <ContractInfoCard />
        <KeeperStatusCard />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <OpportunitiesCard />
        <EventTimeline />
      </div>
    </div>
  );
}
