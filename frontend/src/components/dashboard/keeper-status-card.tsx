"use client";

import { Bot, CircleAlert } from "lucide-react";
import { GlassCard } from "@/components/ui/glass-card";
import { useKeeperStatus } from "@/hooks/useKeeperApi";
import { KEEPER_API_URL } from "@/lib/contract";
import { shortenAddress } from "@/lib/utils";

/** Shows the keeper bot's real, self-reported status via its read-only HTTP
 *  API - no browser-triggered start/stop here. That control plane can't be
 *  an unauthenticated fetch() call from any visitor's browser without being
 *  a real security hole; process control (start/stop/restart) stays a
 *  VPS-side systemctl/pm2/Docker action, documented in the deployment docs. */
export function KeeperStatusCard() {
  const { data, isLoading, isError } = useKeeperStatus();

  return (
    <GlassCard>
      <div className="flex items-center gap-2 mb-4">
        <Bot size={16} className="text-gold" />
        <h3 className="font-medium">Keeper Bot</h3>
      </div>

      {!KEEPER_API_URL ? (
        <p className="text-sm text-muted flex items-start gap-2">
          <CircleAlert size={14} className="mt-0.5 shrink-0" />
          Keeper API not configured (NEXT_PUBLIC_KEEPER_API_URL unset). Bot status is unavailable to the
          frontend, but the keeper still runs independently on your server.
        </p>
      ) : isLoading ? (
        <p className="text-sm text-muted">Checking keeper...</p>
      ) : isError || !data ? (
        <p className="text-sm text-danger flex items-start gap-2">
          <CircleAlert size={14} className="mt-0.5 shrink-0" />
          Keeper unreachable at the configured API URL.
        </p>
      ) : (
        <div className="flex flex-col gap-2 text-sm">
          <Row label="Status" value="Reachable" success />
          <Row label="Mode" value={data.dryRun ? "Dry Run" : "Live Execution"} warn={!data.dryRun} />
          <Row label="Scan Mode" value={data.scanMode} />
          <Row label="Trigger" value={data.triggerMode} />
          <Row label="Keeper Address" value={data.keeperAddress ? shortenAddress(data.keeperAddress, 6) : "none (dry-run)"} />
        </div>
      )}
    </GlassCard>
  );
}

function Row({ label, value, success, warn }: { label: string; value: string; success?: boolean; warn?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted">{label}</span>
      <span className={success ? "text-success font-medium" : warn ? "text-gold font-medium" : "font-medium"}>
        {value}
      </span>
    </div>
  );
}
