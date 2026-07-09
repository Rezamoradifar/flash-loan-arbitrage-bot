"use client";

import Link from "next/link";
import { useState } from "react";
import { usePathname } from "next/navigation";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { Menu, X, Moon, Sun, Languages, ShieldCheck } from "lucide-react";
import { useAccount, useReadContract } from "wagmi";
import { cn } from "@/lib/utils";
import { useTheme } from "@/components/theme-provider";
import { useLocale } from "@/components/locale-provider";
import { Button } from "@/components/ui/button";
import { CONTRACT_ADDRESS } from "@/lib/contract";
import { EXECUTOR_ABI } from "@/lib/executorAbi";

const links = [
  { href: "/", key: "nav.home" },
  { href: "/dashboard", key: "nav.dashboard" },
  { href: "/analytics", key: "nav.analytics" },
  { href: "/transactions", key: "nav.transactions" },
  { href: "/admin", key: "nav.admin" },
  { href: "/settings", key: "nav.settings" },
];

export function Navbar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const { theme, toggle } = useTheme();
  const { t, locale, setLocale } = useLocale();
  const { address } = useAccount();

  const { data: owner } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: EXECUTOR_ABI,
    functionName: "owner",
  });
  const isOwner = !!address && !!owner && address.toLowerCase() === (owner as string).toLowerCase();

  return (
    <header className="sticky top-0 z-50 glass-strong border-b border-white/5">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-gold-soft to-gold text-[#0a0a0b] text-sm font-bold">
            A
          </span>
          <span className="gold-text text-lg">Aave Arbitrage Executor</span>
        </Link>

        <nav className="hidden lg:flex items-center gap-1">
          {links
            .filter((l) => l.key !== "nav.admin" || isOwner)
            .map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className={cn(
                  "rounded-lg px-3 py-2 text-sm transition-colors hover:bg-white/5",
                  pathname === l.href ? "text-gold" : "text-foreground/80"
                )}
              >
                {t(l.key)}
              </Link>
            ))}
        </nav>

        <div className="hidden lg:flex items-center gap-2">
          {isOwner && (
            <span className="flex items-center gap-1 rounded-full border border-gold/30 bg-gold/10 px-2.5 py-1 text-xs text-gold">
              <ShieldCheck size={12} /> Owner
            </span>
          )}
          <Button variant="ghost" size="icon" onClick={() => setLocale(locale === "en" ? "fa" : "en")} aria-label="toggle language">
            <Languages size={16} />
          </Button>
          <Button variant="ghost" size="icon" onClick={toggle} aria-label="toggle theme">
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </Button>
          <ConnectButton showBalance={false} chainStatus="icon" accountStatus={{ smallScreen: "avatar", largeScreen: "full" }} />
        </div>

        <button className="lg:hidden" onClick={() => setOpen((v) => !v)} aria-label="menu">
          {open ? <X size={22} /> : <Menu size={22} />}
        </button>
      </div>

      {open && (
        <div className="lg:hidden border-t border-white/5 px-4 pb-4">
          <nav className="flex flex-col gap-1 pt-2">
            {links
              .filter((l) => l.key !== "nav.admin" || isOwner)
              .map((l) => (
                <Link
                  key={l.href}
                  href={l.href}
                  onClick={() => setOpen(false)}
                  className={cn(
                    "rounded-lg px-3 py-2 text-sm",
                    pathname === l.href ? "text-gold bg-white/5" : "text-foreground/80"
                  )}
                >
                  {t(l.key)}
                </Link>
              ))}
          </nav>
          <div className="mt-3 flex items-center justify-between">
            <div className="flex gap-2">
              <Button variant="ghost" size="icon" onClick={() => setLocale(locale === "en" ? "fa" : "en")}>
                <Languages size={16} />
              </Button>
              <Button variant="ghost" size="icon" onClick={toggle}>
                {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
              </Button>
            </div>
            <ConnectButton showBalance={false} />
          </div>
        </div>
      )}
    </header>
  );
}
