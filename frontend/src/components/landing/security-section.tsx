"use client";

import { Lock, ShieldCheck, Eye, PauseCircle, KeyRound, Skull } from "lucide-react";
import { GlassCard } from "@/components/ui/glass-card";
import { useLocale } from "@/components/locale-provider";

const items = [
  {
    icon: Lock,
    title: "Non-Custodial by Design",
    body: "Flash loans are borrowed and repaid atomically within a single transaction. The contract never holds user deposits.",
  },
  {
    icon: KeyRound,
    title: "Ownable2Step Access Control",
    body: "Ownership transfers require explicit two-step acceptance, eliminating accidental transfer to an unreachable address.",
  },
  {
    icon: PauseCircle,
    title: "Emergency Pause",
    body: "The owner can pause execution instantly if an anomaly is detected, halting all new arbitrage operations.",
  },
  {
    icon: ShieldCheck,
    title: "Whitelisted Routers & Assets",
    body: "Only explicitly approved DEX routers and tokens can be used in any execution path - no arbitrary external calls.",
  },
  {
    icon: Eye,
    title: "On-Chain Verifiable",
    body: "Every flash loan, swap, and profit event is emitted on-chain and independently verifiable on BscScan.",
  },
  {
    icon: Skull,
    title: "Reentrancy Protected",
    body: "All state-changing entry points are guarded with OpenZeppelin's ReentrancyGuard.",
  },
];

export function SecuritySection() {
  const { t } = useLocale();
  return (
    <section className="mx-auto max-w-7xl px-4 sm:px-6 py-16">
      <h2 className="text-2xl sm:text-3xl font-semibold text-center mb-10">
        <span className="gold-text">{t("security.title")}</span>
      </h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {items.map(({ icon: Icon, title, body }) => (
          <GlassCard key={title} className="flex flex-col gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-gold/10 text-gold">
              <Icon size={18} />
            </span>
            <h3 className="font-medium">{title}</h3>
            <p className="text-sm text-muted">{body}</p>
          </GlassCard>
        ))}
      </div>
    </section>
  );
}
