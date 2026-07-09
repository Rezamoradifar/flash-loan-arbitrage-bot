"use client";

import { useReadContract, useReadContracts, useBlockNumber, useGasPrice } from "wagmi";
import { CONTRACT_ADDRESS, KNOWN_ASSETS } from "@/lib/contract";
import { EXECUTOR_ABI } from "@/lib/executorAbi";

const assetAddresses = Object.keys(KNOWN_ASSETS) as `0x${string}`[];

/** Narrow single-function ABI for the batched getBalance() reads below -
 *  passing the full 116-entry contract ABI into useReadContracts' per-item
 *  generic across a 6-item array makes TypeScript's type instantiation
 *  exceed its recursion budget ("Type instantiation is excessively deep").
 *  A single-entry ABI keeps inference shallow while still being fully typed. */
const GET_BALANCE_ABI = [
  {
    type: "function",
    name: "getBalance",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address", internalType: "address" }],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
  },
] as const;

/** Real on-chain reads only - no mocked/fabricated numbers. `getOperationStats`
 *  returns (totalFlashLoans, totalProfit, totalOperations) per the contract's
 *  own bookkeeping; balances are read live per whitelisted asset. */
export function useContractStats() {
  const { data: opStats, isLoading: statsLoading } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: EXECUTOR_ABI,
    functionName: "getOperationStats",
  });

  const { data: balances, isLoading: balancesLoading } = useReadContracts({
    contracts: assetAddresses.map((addr) => ({
      address: CONTRACT_ADDRESS,
      abi: GET_BALANCE_ABI,
      functionName: "getBalance",
      args: [addr],
    })),
  });

  const { data: blockNumber } = useBlockNumber({ watch: true });
  const { data: gasPrice } = useGasPrice();

  const { data: paused } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: EXECUTOR_ABI,
    functionName: "paused",
  });

  const balanceByAsset = assetAddresses.map((addr, i) => ({
    address: addr,
    symbol: KNOWN_ASSETS[addr].symbol,
    decimals: KNOWN_ASSETS[addr].decimals,
    balance: (balances?.[i]?.result as bigint | undefined) ?? 0n,
  }));

  const [totalOps, flashLoans, profit] = (opStats as readonly [bigint, bigint, bigint]) ?? [
    undefined,
    undefined,
    undefined,
  ];

  return {
    totalOperations: totalOps,
    totalFlashLoans: flashLoans,
    totalProfit: profit,
    balanceByAsset,
    blockNumber,
    gasPrice,
    paused: Boolean(paused),
    isLoading: statsLoading || balancesLoading,
  };
}
