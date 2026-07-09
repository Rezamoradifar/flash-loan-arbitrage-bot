"use client";

import { useQuery } from "@tanstack/react-query";
import { KEEPER_API_URL } from "@/lib/contract";
import { useSettings } from "@/components/settings-provider";

export interface KeeperStatus {
  chainId: string;
  keeperAddress: string | null;
  executorAddress: string | null;
  scanMode: string;
  triggerMode: string;
  dryRun: boolean;
}

export interface KeeperOpportunity {
  name: string;
  baseAsset: { symbol: string; address: string; decimals: number };
  amount: string;
  grossOut: string;
  netProfit: string;
  executable: boolean;
  breakdown: unknown;
}

export interface KeeperOpportunities {
  lastScanAt: number | null;
  durationMs: number | null;
  count: number;
  opportunities: KeeperOpportunity[];
}

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${KEEPER_API_URL}${path}`);
  if (!res.ok) throw new Error(`Keeper API ${path} returned ${res.status}`);
  return res.json() as Promise<T>;
}

/** Reads the keeper's own read-only monitoring API (see keeper/src/api.ts).
 *  Not configured (NEXT_PUBLIC_KEEPER_API_URL unset) => queries stay
 *  disabled and the UI shows "keeper not connected" rather than guessing. */
export function useKeeperStatus() {
  const { refreshIntervalMs } = useSettings();
  return useQuery({
    queryKey: ["keeper-status"],
    queryFn: () => fetchJson<KeeperStatus>("/api/status"),
    enabled: !!KEEPER_API_URL,
    refetchInterval: refreshIntervalMs,
    retry: 1,
  });
}

export function useKeeperOpportunities() {
  const { refreshIntervalMs } = useSettings();
  return useQuery({
    queryKey: ["keeper-opportunities"],
    queryFn: () => fetchJson<KeeperOpportunities>("/api/opportunities"),
    enabled: !!KEEPER_API_URL,
    refetchInterval: refreshIntervalMs,
    retry: 1,
  });
}

export function useKeeperMetrics() {
  const { refreshIntervalMs } = useSettings();
  return useQuery({
    queryKey: ["keeper-metrics"],
    queryFn: () => fetchJson<Record<string, unknown>>("/api/metrics"),
    enabled: !!KEEPER_API_URL,
    refetchInterval: refreshIntervalMs,
    retry: 1,
  });
}
