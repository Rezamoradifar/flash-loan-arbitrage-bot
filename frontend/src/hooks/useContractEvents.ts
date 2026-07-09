"use client";

import { useEffect, useRef, useState } from "react";
import { usePublicClient, useBlockNumber } from "wagmi";
import type { Log } from "viem";
import { CONTRACT_ADDRESS } from "@/lib/contract";
import { EXECUTOR_ABI } from "@/lib/executorAbi";
import { TRACKED_EVENT_NAMES, type TrackedEventName } from "@/lib/eventNames";

export interface TimelineEvent {
  id: string;
  name: TrackedEventName;
  blockNumber: bigint;
  transactionHash: string;
  logIndex: number;
  args: Record<string, unknown>;
}

const LOOKBACK_BLOCKS = BigInt(process.env.NEXT_PUBLIC_EVENTS_LOOKBACK_BLOCKS ?? "5000");
const CHUNK_SIZE = 2000n;
const MAX_EVENTS = 200;

function isTracked(name: string | undefined): name is TrackedEventName {
  return !!name && (TRACKED_EVENT_NAMES as readonly string[]).includes(name);
}

function toTimelineEvent(log: Log & { eventName?: string; args?: Record<string, unknown> }): TimelineEvent | null {
  if (!isTracked(log.eventName)) return null;
  return {
    id: `${log.transactionHash}-${log.logIndex}`,
    name: log.eventName,
    blockNumber: log.blockNumber ?? 0n,
    transactionHash: log.transactionHash ?? "",
    logIndex: log.logIndex ?? 0,
    args: log.args ?? {},
  };
}

/** Fetches recent history (bounded lookback window, chunked to respect RPC
 *  eth_getLogs range limits) then subscribes to live new events for the same
 *  11 tracked event types - no synthetic/fabricated activity, only what the
 *  contract has actually emitted on-chain. */
export function useContractEvents() {
  const publicClient = usePublicClient();
  const { data: currentBlock } = useBlockNumber();
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (!publicClient || !currentBlock || fetchedRef.current) return;
    fetchedRef.current = true;

    (async () => {
      try {
        const fromBlock = currentBlock > LOOKBACK_BLOCKS ? currentBlock - LOOKBACK_BLOCKS : 0n;
        const ranges: Array<[bigint, bigint]> = [];
        for (let start = fromBlock; start <= currentBlock; start += CHUNK_SIZE) {
          const end = start + CHUNK_SIZE - 1n > currentBlock ? currentBlock : start + CHUNK_SIZE - 1n;
          ranges.push([start, end]);
        }

        const results = await Promise.all(
          ranges.map(([from, to]) =>
            publicClient.getContractEvents({
              address: CONTRACT_ADDRESS,
              abi: EXECUTOR_ABI,
              fromBlock: from,
              toBlock: to,
            })
          )
        );

        const all = results
          .flat()
          .map(toTimelineEvent)
          .filter((e): e is TimelineEvent => e !== null)
          .sort((a, b) => (a.blockNumber === b.blockNumber ? b.logIndex - a.logIndex : Number(b.blockNumber - a.blockNumber)))
          .slice(0, MAX_EVENTS);

        setEvents(all);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, [publicClient, currentBlock]);

  useEffect(() => {
    if (!publicClient) return;
    const unwatch = publicClient.watchContractEvent({
      address: CONTRACT_ADDRESS,
      abi: EXECUTOR_ABI,
      onLogs: (logs) => {
        const fresh = logs.map(toTimelineEvent).filter((e): e is TimelineEvent => e !== null);
        if (fresh.length === 0) return;
        setEvents((prev) => {
          const seen = new Set(prev.map((e) => e.id));
          const merged = [...fresh.filter((e) => !seen.has(e.id)), ...prev];
          return merged.slice(0, MAX_EVENTS);
        });
      },
    });
    return () => unwatch();
  }, [publicClient]);

  return { events, loading, error };
}
