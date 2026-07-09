"use client";

import { useEffect, useRef, useState } from "react";
import { usePublicClient, useBlockNumber } from "wagmi";
import { CONTRACT_ADDRESS, KNOWN_ASSETS, labelAsset } from "@/lib/contract";

const LOOKBACK_BLOCKS = BigInt(process.env.NEXT_PUBLIC_EVENTS_LOOKBACK_BLOCKS ?? "5000");
const CHUNK_SIZE = 2000n;
const MAX_RECEIPT_FETCHES = 120;

export interface ExecutionRecord {
  txHash: string;
  blockNumber: bigint;
  asset: string;
  assetSymbol: string;
  amountBorrowed: bigint;
  grossProfit: bigint;
  protocolFee: bigint;
  netProfit: bigint;
  timestamp: number | null;
  gasUsed: bigint | null;
}

export interface SwapRecord {
  router: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
}

export interface AnalyticsData {
  executions: ExecutionRecord[];
  swaps: SwapRecord[];
  flashLoanCount: number;
  loading: boolean;
  error: string | null;
}

const arbitrageExecutedEvent = {
  type: "event",
  name: "ArbitrageExecuted",
  inputs: [
    { name: "asset", type: "address", indexed: true },
    { name: "amountBorrowed", type: "uint256", indexed: false },
    { name: "grossProfit", type: "uint256", indexed: false },
    { name: "protocolFee", type: "uint256", indexed: false },
    { name: "netProfit", type: "uint256", indexed: false },
  ],
} as const;

const swapExecutedEvent = {
  type: "event",
  name: "SwapExecuted",
  inputs: [
    { name: "router", type: "address", indexed: true },
    { name: "tokenIn", type: "address", indexed: true },
    { name: "tokenOut", type: "address", indexed: false },
    { name: "amountIn", type: "uint256", indexed: false },
    { name: "amountOut", type: "uint256", indexed: false },
  ],
} as const;

const flashLoanStartedEvent = {
  type: "event",
  name: "FlashLoanStarted",
  inputs: [
    { name: "asset", type: "address", indexed: true },
    { name: "amount", type: "uint256", indexed: false },
  ],
} as const;

/** Real on-chain history only: pulls ArbitrageExecuted (profit-per-asset,
 *  profit-over-time), SwapExecuted (router volume distribution), and
 *  FlashLoanStarted (loan count) logs over a bounded lookback window, then
 *  resolves block timestamps and transaction gas cost for each execution.
 *  Nothing here is estimated or fabricated - if the contract hasn't emitted
 *  an event, it doesn't appear in any chart. */
export function useAnalyticsHistory(): AnalyticsData {
  const publicClient = usePublicClient();
  const { data: currentBlock } = useBlockNumber();
  const [state, setState] = useState<Omit<AnalyticsData, "loading" | "error">>({
    executions: [],
    swaps: [],
    flashLoanCount: 0,
  });
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

        const [execLogs, swapLogs, flashLogs] = await Promise.all([
          Promise.all(
            ranges.map(([from, to]) =>
              publicClient.getLogs({ address: CONTRACT_ADDRESS, event: arbitrageExecutedEvent, fromBlock: from, toBlock: to })
            )
          ).then((r) => r.flat()),
          Promise.all(
            ranges.map(([from, to]) =>
              publicClient.getLogs({ address: CONTRACT_ADDRESS, event: swapExecutedEvent, fromBlock: from, toBlock: to })
            )
          ).then((r) => r.flat()),
          Promise.all(
            ranges.map(([from, to]) =>
              publicClient.getLogs({ address: CONTRACT_ADDRESS, event: flashLoanStartedEvent, fromBlock: from, toBlock: to })
            )
          ).then((r) => r.flat()),
        ]);

        const uniqueBlocks = Array.from(new Set(execLogs.map((l) => l.blockNumber))).slice(0, MAX_RECEIPT_FETCHES);
        const blockTimestamps = new Map<bigint, number>();
        await Promise.all(
          uniqueBlocks.map(async (bn) => {
            if (bn === null) return;
            try {
              const block = await publicClient.getBlock({ blockNumber: bn });
              blockTimestamps.set(bn, Number(block.timestamp) * 1000);
            } catch {
              /* best-effort - chart falls back to block number ordering */
            }
          })
        );

        const receiptTargets = execLogs.slice(0, MAX_RECEIPT_FETCHES);
        const gasByTx = new Map<string, bigint>();
        await Promise.all(
          receiptTargets.map(async (log) => {
            if (!log.transactionHash) return;
            try {
              const receipt = await publicClient.getTransactionReceipt({ hash: log.transactionHash });
              gasByTx.set(log.transactionHash, receipt.gasUsed * receipt.effectiveGasPrice);
            } catch {
              /* best-effort */
            }
          })
        );

        const executions: ExecutionRecord[] = execLogs.map((log) => {
          const args = log.args as {
            asset: string;
            amountBorrowed: bigint;
            grossProfit: bigint;
            protocolFee: bigint;
            netProfit: bigint;
          };
          return {
            txHash: log.transactionHash ?? "",
            blockNumber: log.blockNumber ?? 0n,
            asset: args.asset,
            assetSymbol: labelAsset(args.asset),
            amountBorrowed: args.amountBorrowed,
            grossProfit: args.grossProfit,
            protocolFee: args.protocolFee,
            netProfit: args.netProfit,
            timestamp: log.blockNumber ? blockTimestamps.get(log.blockNumber) ?? null : null,
            gasUsed: log.transactionHash ? gasByTx.get(log.transactionHash) ?? null : null,
          };
        });

        const swaps: SwapRecord[] = swapLogs.map((log) => {
          const args = log.args as { router: string; tokenIn: string; tokenOut: string; amountIn: bigint };
          return { router: args.router, tokenIn: args.tokenIn, tokenOut: args.tokenOut, amountIn: args.amountIn };
        });

        setState({ executions, swaps, flashLoanCount: flashLogs.length });
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, [publicClient, currentBlock]);

  return { ...state, loading, error };
}

export const ANALYTICS_KNOWN_ASSETS = KNOWN_ASSETS;
