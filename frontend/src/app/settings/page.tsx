"use client";

import { useState } from "react";
import { Settings as SettingsIcon, Copy, Check } from "lucide-react";
import { GlassCard } from "@/components/ui/glass-card";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/components/theme-provider";
import { useLocale } from "@/components/locale-provider";
import { useSettings } from "@/components/settings-provider";
import { CONTRACT_ADDRESS, KEEPER_API_URL } from "@/lib/contract";

function CopyableField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted">{label}</span>
      <div className="flex items-center gap-2">
        <code className="flex-1 truncate rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs">{value}</code>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => {
            navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
        </Button>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const { locale, setLocale, t } = useLocale();
  const { refreshIntervalMs, setRefreshIntervalMs, currency, setCurrency } = useSettings();

  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6 py-10">
      <div className="flex items-center gap-2 mb-1">
        <SettingsIcon size={20} className="text-gold" />
        <h1 className="text-2xl font-semibold">{t("nav.settings")}</h1>
      </div>
      <p className="text-sm text-muted mb-8">Preferences are saved locally in your browser.</p>

      <div className="flex flex-col gap-4">
        <GlassCard>
          <h3 className="font-medium mb-4">Appearance</h3>
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-sm">Theme</p>
              <p className="text-xs text-muted">Switch between dark (default) and light glass theme.</p>
            </div>
            <div className="flex gap-2">
              <Button variant={theme === "dark" ? "default" : "outline"} size="sm" onClick={() => setTheme("dark")}>
                Dark
              </Button>
              <Button variant={theme === "light" ? "default" : "outline"} size="sm" onClick={() => setTheme("light")}>
                Light
              </Button>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm">Language</p>
              <p className="text-xs text-muted">English / فارسی</p>
            </div>
            <div className="flex gap-2">
              <Button variant={locale === "en" ? "default" : "outline"} size="sm" onClick={() => setLocale("en")}>
                English
              </Button>
              <Button variant={locale === "fa" ? "default" : "outline"} size="sm" onClick={() => setLocale("fa")}>
                فارسی
              </Button>
            </div>
          </div>
        </GlassCard>

        <GlassCard>
          <h3 className="font-medium mb-4">Data Refresh</h3>
          <div className="flex items-center justify-between mb-2">
            <div>
              <p className="text-sm">Keeper API refresh interval</p>
              <p className="text-xs text-muted">
                How often the dashboard/analytics pages poll the keeper&apos;s status, opportunities, and metrics
                endpoints.
              </p>
            </div>
            <select
              value={refreshIntervalMs}
              onChange={(e) => setRefreshIntervalMs(Number(e.target.value))}
              className="h-9 rounded-lg border border-white/10 bg-white/5 px-3 text-sm outline-none focus:border-gold/50"
            >
              <option value={5000}>5s</option>
              <option value={10000}>10s</option>
              <option value={30000}>30s</option>
              <option value={60000}>60s</option>
            </select>
          </div>
          <p className="text-xs text-muted">
            On-chain reads (balances, block number, wallet) refresh automatically on every new block regardless of
            this setting.
          </p>
        </GlassCard>

        <GlassCard>
          <h3 className="font-medium mb-4">Display Currency</h3>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm">Amount display</p>
              <p className="text-xs text-muted">
                USD conversion requires a live price oracle, which this frontend does not query to avoid showing an
                estimated figure as if it were exact. Amounts always display in native token units regardless of
                this preference for now.
              </p>
            </div>
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value as "native" | "usd")}
              className="h-9 rounded-lg border border-white/10 bg-white/5 px-3 text-sm outline-none focus:border-gold/50"
            >
              <option value="native">Native Token</option>
              <option value="usd">USD (est., not yet wired)</option>
            </select>
          </div>
        </GlassCard>

        <GlassCard>
          <h3 className="font-medium mb-4">Network Configuration</h3>
          <div className="flex flex-col gap-4">
            <CopyableField label="Contract Address" value={CONTRACT_ADDRESS} />
            <CopyableField label="Keeper API URL" value={KEEPER_API_URL || "(not configured)"} />
          </div>
          <p className="text-xs text-muted mt-4">
            These are build-time configuration (NEXT_PUBLIC_CONTRACT_ADDRESS, NEXT_PUBLIC_RPC_URL,
            NEXT_PUBLIC_KEEPER_API_URL) - set them in .env.local and rebuild to point this frontend at a different
            deployment or RPC endpoint.
          </p>
        </GlassCard>
      </div>
    </div>
  );
}
