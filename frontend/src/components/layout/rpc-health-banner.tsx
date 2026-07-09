"use client";

import { WifiOff } from "lucide-react";
import { useRpcHealth } from "@/hooks/useRpcHealth";

export function RpcHealthBanner() {
  const health = useRpcHealth();

  if (health !== "unreachable") return null;

  return (
    <div className="flex items-center justify-center gap-2 bg-danger/15 px-4 py-2 text-center text-xs text-danger">
      <WifiOff size={14} className="shrink-0" />
      <span>
        Can&apos;t reach the configured RPC endpoint - contract data won&apos;t load. Set
        <code className="mx-1 rounded bg-black/20 px-1 py-0.5">NEXT_PUBLIC_RPC_URL</code>
        to a working BNB Smart Chain RPC and restart.
      </span>
    </div>
  );
}
