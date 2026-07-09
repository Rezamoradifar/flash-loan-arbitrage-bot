"use client";

import { FileCode2, GitBranch, TestTube2 } from "lucide-react";
import { GlassCard } from "@/components/ui/glass-card";
import { CONTRACT_ADDRESS, BSCSCAN_ADDRESS_URL } from "@/lib/contract";
import { shortenAddress } from "@/lib/utils";
import { useLocale } from "@/components/locale-provider";

export function AuditSection() {
  const { t } = useLocale();
  return (
    <section className="mx-auto max-w-7xl px-4 sm:px-6 py-16">
      <h2 className="text-2xl sm:text-3xl font-semibold text-center mb-10">
        <span className="gold-text">{t("audit.title")}</span>
      </h2>
      <div className="grid gap-4 sm:grid-cols-3">
        <GlassCard>
          <FileCode2 className="text-gold mb-3" size={20} />
          <h3 className="font-medium mb-1">Open Source</h3>
          <p className="text-sm text-muted">
            Full Solidity source, Foundry test suite, and keeper bot are public - nothing is closed-source.
          </p>
        </GlassCard>
        <GlassCard>
          <TestTube2 className="text-gold mb-3" size={20} />
          <h3 className="font-medium mb-1">Extensively Tested</h3>
          <p className="text-sm text-muted">
            Deterministic Foundry unit tests plus real BSC mainnet fork tests cover flash-loan repayment,
            profit accounting, access control, and pause behavior.
          </p>
        </GlassCard>
        <GlassCard>
          <GitBranch className="text-gold mb-3" size={20} />
          <h3 className="font-medium mb-1">Verified Deployment</h3>
          <p className="text-sm text-muted mb-2">
            Live contract, independently verifiable on BscScan:
          </p>
          <a
            href={BSCSCAN_ADDRESS_URL(CONTRACT_ADDRESS)}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-gold hover:underline"
          >
            {shortenAddress(CONTRACT_ADDRESS, 6)} ↗
          </a>
        </GlassCard>
      </div>
    </section>
  );
}
