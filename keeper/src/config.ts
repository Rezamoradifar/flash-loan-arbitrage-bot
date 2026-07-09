import "dotenv/config";
import { readFileSync } from "node:fs";

export interface HopConfig {
  router: string;
  quoter: string;
  routerType: 0 | 1 | 2;
  tokenIn: string;
  tokenOut: string;
  v3Fee: number;
  stableI: number;
  stableJ: number;
}

export interface StrategyConfig {
  name: string;
  minProfitOverride: string;
  slippageBpsOverride: number;
  hops: HopConfig[];
}

export interface StrategiesFile {
  asset: { symbol: string; address: string; flashLoanAmount: string };
  strategies: StrategyConfig[];
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name} (see .env.example)`);
  return v;
}

export const config = {
  rpcUrl: requireEnv("RPC_URL"),
  privateKey: requireEnv("PRIVATE_KEY"),
  executorAddress: requireEnv("EXECUTOR_ADDRESS"),
  strategiesFile: process.env.STRATEGIES_FILE ?? "./strategies.json",
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 6000),
  dryRun: (process.env.DRY_RUN ?? "true").toLowerCase() !== "false",
  minNetProfit: BigInt(process.env.MIN_NET_PROFIT ?? "0"),
  slippageBps: Number(process.env.SLIPPAGE_BPS ?? 0),
};

export function loadStrategies(): StrategiesFile {
  const raw = readFileSync(config.strategiesFile, "utf-8");
  const parsed = JSON.parse(raw) as StrategiesFile;
  if (!parsed.strategies?.length) {
    throw new Error(`No strategies found in ${config.strategiesFile}`);
  }
  return parsed;
}
