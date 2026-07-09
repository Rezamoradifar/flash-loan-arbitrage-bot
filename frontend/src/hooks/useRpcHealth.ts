"use client";

import { useEffect, useRef, useState } from "react";
import { usePublicClient } from "wagmi";
import { withTimeout } from "@/lib/rpcUtils";

export type RpcHealth = "checking" | "ok" | "unreachable";

const CHECK_TIMEOUT_MS = 8_000;
const RECHECK_INTERVAL_MS = 30_000;

/** Cheap, direct connectivity probe (single getBlockNumber call) so the app
 *  can show one honest, actionable banner ("can't reach your RPC") instead
 *  of a dozen silent per-card "—" placeholders when the configured endpoint
 *  is down, rate-limited, or blocked by CORS. Rechecks periodically so the
 *  banner clears itself once the endpoint recovers. */
export function useRpcHealth(): RpcHealth {
  const publicClient = usePublicClient();
  const [status, setStatus] = useState<RpcHealth>("checking");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!publicClient) return;
    let cancelled = false;

    async function check() {
      try {
        await withTimeout(publicClient!.getBlockNumber(), CHECK_TIMEOUT_MS, "RPC health check");
        if (!cancelled) setStatus("ok");
      } catch {
        if (!cancelled) setStatus("unreachable");
      } finally {
        if (!cancelled) {
          timerRef.current = setTimeout(check, RECHECK_INTERVAL_MS);
        }
      }
    }

    check();

    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [publicClient]);

  return status;
}
