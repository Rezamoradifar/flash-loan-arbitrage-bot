"use client";

import { CheckCircle2, Circle, CircleDot } from "lucide-react";
import { useLocale } from "@/components/locale-provider";

const phases = [
  { title: "Core Flash-Loan Executor", status: "done", body: "Aave V3 flash loans, multi-hop swap execution, on-chain profit validation." },
  { title: "Multi-DEX Scanner", status: "done", body: "PancakeSwap V2/V3, Biswap, ApeSwap, BakerySwap, Wombat route generation and quoting." },
  { title: "Production Deployment", status: "done", body: "Deployed and verified on BNB Smart Chain mainnet with owner-controlled whitelists." },
  { title: "Institutional Dashboard", status: "active", body: "Real-time monitoring, admin panel, analytics, and multi-wallet support (this site)." },
  { title: "Expanded DEX Coverage", status: "planned", body: "THENA and additional concentrated-liquidity venues, pending verified interface review." },
  { title: "Cross-Chain Expansion", status: "planned", body: "Evaluate additional Aave V3 deployments (Arbitrum, Base, Polygon) for the same architecture." },
];

const statusIcon = { done: CheckCircle2, active: CircleDot, planned: Circle };
const statusColor = { done: "text-success", active: "text-gold", planned: "text-muted" };

export function RoadmapSection() {
  const { t } = useLocale();
  return (
    <section className="mx-auto max-w-4xl px-4 sm:px-6 py-16">
      <h2 className="text-2xl sm:text-3xl font-semibold text-center mb-10">
        <span className="gold-text">{t("roadmap.title")}</span>
      </h2>
      <div className="flex flex-col gap-6">
        {phases.map((p) => {
          const Icon = statusIcon[p.status as keyof typeof statusIcon];
          return (
            <div key={p.title} className="flex gap-4">
              <Icon className={cnColor(p.status)} size={20} />
              <div>
                <h3 className="font-medium">{p.title}</h3>
                <p className="text-sm text-muted">{p.body}</p>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function cnColor(status: string) {
  return statusColor[status as keyof typeof statusColor];
}
