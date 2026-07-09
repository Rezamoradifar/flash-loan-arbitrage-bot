"use client";

import Link from "next/link";
import { CONTRACT_ADDRESS, BSCSCAN_ADDRESS_URL } from "@/lib/contract";
import { shortenAddress } from "@/lib/utils";
import { useLocale } from "@/components/locale-provider";

export function Footer() {
  const { t } = useLocale();
  return (
    <footer className="border-t border-white/5 mt-24">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-10 flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
        <div>
          <span className="gold-text font-semibold">Aave Arbitrage Executor</span>
          <p className="mt-1 text-xs text-muted max-w-sm">
            Autonomous flash-loan arbitrage on BNB Smart Chain. All execution is on-chain and
            independently verifiable - nothing here is simulated or fabricated.
          </p>
        </div>
        <div className="flex flex-col gap-2 text-xs text-muted">
          <a
            href={BSCSCAN_ADDRESS_URL(CONTRACT_ADDRESS)}
            target="_blank"
            rel="noreferrer"
            className="hover:text-gold transition-colors"
          >
            Contract: {shortenAddress(CONTRACT_ADDRESS, 6)} ↗
          </a>
          <div className="flex gap-4">
            <Link href="/dashboard" className="hover:text-gold transition-colors">
              Dashboard
            </Link>
            <Link href="/analytics" className="hover:text-gold transition-colors">
              Analytics
            </Link>
            <Link href="/settings" className="hover:text-gold transition-colors">
              Settings
            </Link>
          </div>
        </div>
      </div>
      <div className="border-t border-white/5 py-4 text-center text-[11px] text-muted">
        © {new Date().getFullYear()} Aave Arbitrage Executor. {t("footer.rights")}
      </div>
    </footer>
  );
}
