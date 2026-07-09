"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { GlassCard } from "@/components/ui/glass-card";
import { cn } from "@/lib/utils";
import { useLocale } from "@/components/locale-provider";

const faqs = [
  {
    q: "What is a flash-loan arbitrage bot?",
    a: "It borrows a large sum of a single asset (via Aave V3's flashLoanSimple), swaps it across a sequence of DEX pools, and repays the loan plus a fee - all inside one atomic transaction. If the swap sequence doesn't produce enough to repay the loan and the fee, the entire transaction reverts and nothing happens - there is no partial-loss scenario.",
  },
  {
    q: "How is profitability determined before execution?",
    a: "The keeper simulates the full route off-chain (flash-loan fee + swap fees + price impact + gas cost), and the contract itself re-validates expected net profit on-chain before executing. A trade is only submitted if net profit clears a configurable minimum threshold after every cost.",
  },
  {
    q: "Who can trigger arbitrage execution?",
    a: "Only the configured keeper address or the contract owner - executeArbitrage() reverts for any other caller.",
  },
  {
    q: "What happens if the market moves against the trade mid-transaction?",
    a: "Per-hop slippage protection (amountOutMin) and the atomic nature of the transaction mean an unprofitable or failed swap sequence simply reverts the whole transaction - the flash loan is never taken if it can't be repaid.",
  },
  {
    q: "Can the owner withdraw user funds?",
    a: "There are no user deposits to withdraw - this contract only ever holds funds transiently within a single flash-loan transaction. rescueTokens/rescueNative exist solely to recover accidentally-sent tokens, not to withdraw operational funds.",
  },
];

export function FaqSection() {
  const { t } = useLocale();
  const [openIndex, setOpenIndex] = useState<number | null>(0);
  return (
    <section className="mx-auto max-w-4xl px-4 sm:px-6 py-16">
      <h2 className="text-2xl sm:text-3xl font-semibold text-center mb-10">
        <span className="gold-text">{t("faq.title")}</span>
      </h2>
      <div className="flex flex-col gap-3">
        {faqs.map((item, i) => {
          const open = openIndex === i;
          return (
            <GlassCard key={item.q} className="p-0 overflow-hidden">
              <button
                className="flex w-full items-center justify-between gap-4 px-6 py-4 text-left"
                onClick={() => setOpenIndex(open ? null : i)}
              >
                <span className="font-medium text-sm sm:text-base">{item.q}</span>
                <ChevronDown className={cn("shrink-0 text-gold transition-transform", open && "rotate-180")} size={18} />
              </button>
              {open && <p className="px-6 pb-4 text-sm text-muted">{item.a}</p>}
            </GlassCard>
          );
        })}
      </div>
    </section>
  );
}
