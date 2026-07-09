"use client";

import { createContext, useContext, useEffect, useState } from "react";

export type Currency = "native" | "usd";

interface SettingsContextValue {
  refreshIntervalMs: number;
  setRefreshIntervalMs: (ms: number) => void;
  currency: Currency;
  setCurrency: (c: Currency) => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);
const STORAGE_KEY = "arb-frontend-settings";

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [refreshIntervalMs, setRefreshIntervalMsState] = useState(10_000);
  const [currency, setCurrencyState] = useState<Currency>("native");

  useEffect(() => {
    // Deliberate mount-only setState: localStorage is unavailable during SSR,
    // so persisted settings can only be read and applied post-hydration.
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { refreshIntervalMs?: number; currency?: Currency };
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (parsed.refreshIntervalMs) setRefreshIntervalMsState(parsed.refreshIntervalMs);
      if (parsed.currency) setCurrencyState(parsed.currency);
    } catch {
      /* ignore malformed stored settings */
    }
  }, []);

  function persist(next: { refreshIntervalMs: number; currency: Currency }) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }

  const setRefreshIntervalMs = (ms: number) => {
    setRefreshIntervalMsState(ms);
    persist({ refreshIntervalMs: ms, currency });
  };
  const setCurrency = (c: Currency) => {
    setCurrencyState(c);
    persist({ refreshIntervalMs, currency: c });
  };

  return (
    <SettingsContext.Provider value={{ refreshIntervalMs, setRefreshIntervalMs, currency, setCurrency }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used within SettingsProvider");
  return ctx;
}
