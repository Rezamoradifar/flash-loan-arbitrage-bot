"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { ArrowRight, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/components/locale-provider";

export function Hero() {
  const { t } = useLocale();
  return (
    <section className="relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute left-1/2 top-[-10%] h-[560px] w-[560px] -translate-x-1/2 rounded-full bg-gold/10 blur-[120px] animate-pulse-glow" />
        <div className="absolute right-[8%] top-[20%] h-[280px] w-[280px] rounded-full bg-gold/5 blur-[100px] animate-float" />
      </div>

      <div className="mx-auto max-w-7xl px-4 sm:px-6 pt-20 pb-24 text-center">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="mx-auto mb-6 inline-flex items-center gap-2 rounded-full border border-gold/25 bg-gold/5 px-4 py-1.5 text-xs text-gold"
        >
          <Zap size={12} /> Live on BNB Smart Chain Mainnet
        </motion.div>

        <motion.h1
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.05 }}
          className="mx-auto max-w-4xl text-4xl sm:text-6xl font-semibold tracking-tight"
        >
          <span className="gold-text">{t("hero.title")}</span>
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.1 }}
          className="mx-auto mt-6 max-w-2xl text-balance text-foreground/70 text-base sm:text-lg"
        >
          {t("hero.subtitle")}
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.15 }}
          className="mt-10 flex flex-wrap items-center justify-center gap-3"
        >
          <Button asChild size="lg">
            <Link href="/dashboard">
              {t("hero.cta.dashboard")} <ArrowRight size={16} />
            </Link>
          </Button>
          <ConnectButton.Custom>
            {({ openConnectModal, account }) =>
              !account ? (
                <Button variant="outline" size="lg" onClick={openConnectModal}>
                  {t("hero.cta.connect")}
                </Button>
              ) : null
            }
          </ConnectButton.Custom>
        </motion.div>
      </div>
    </section>
  );
}
