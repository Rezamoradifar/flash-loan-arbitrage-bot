import "dotenv/config";
import { readFileSync } from "node:fs";
import type { RouterInfo, TokenInfo } from "./routes.js";

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

/** DRY_RUN is read directly (not via `config`, which doesn't exist yet while
 *  we're building it) so PRIVATE_KEY/EXECUTOR_ADDRESS can be conditionally
 *  required below - a pure simulate-and-log run needs neither: it never
 *  signs or broadcasts anything. */
const dryRun = (process.env.DRY_RUN ?? "true").toLowerCase() !== "false";

function requireEnvUnlessDryRun(name: string): string | undefined {
  const v = process.env[name];
  if (!v && !dryRun) {
    throw new Error(`Missing required env var ${name} (required when DRY_RUN=false; see .env.example)`);
  }
  return v;
}

export interface RoutesConfigFile {
  wrappedNative: TokenInfo;
  baseAssets: TokenInfo[];
  intermediateTokens: TokenInfo[];
  routers: RouterInfo[];
  probeAmountByAssetAddress: Record<string, string>;
  gasUnitsPerTrade: number;
  /** Extra haircut applied to a route's quoted output before comparing to
   *  costs, on top of the on-chain execution slippage tolerance - accounts
   *  for the fact that a quote can move between when it's fetched and when
   *  the transaction actually lands. */
  slippageBufferBps: number;
  /** Passed as executeArbitrage's on-chain slippageBPS (amountOutMin tolerance per hop). */
  executionSlippageBps: number;
  minProfitByAssetAddress: Record<string, string>;
  /** Illiquid-pool filter (requirement: "ignore illiquid pools"): a V2-style
   *  hop is rejected if trading the full probe amount shows more than this
   *  much price impact versus a 1%-of-probe reference quote on the same
   *  pool. 0 or omitted disables the check (saves one eth_call per hop). */
  maxPriceImpactBps?: number;
}

export const config = {
  rpcUrl: requireEnv("RPC_URL"),
  // Both optional when DRY_RUN=true: a pure simulate-and-log run needs a
  // read-only provider connection but never signs or broadcasts anything, so
  // it needs neither a real wallet nor a deployed contract. Required (and
  // validated above) the moment DRY_RUN=false, since that path really does
  // sign and submit executeArbitrage() transactions.
  privateKey: requireEnvUnlessDryRun("PRIVATE_KEY"),
  executorAddress: requireEnvUnlessDryRun("EXECUTOR_ADDRESS"),
  // "dynamic" = multi-DEX/multi-asset/multi-hop auto-scanner (routes.config.json).
  // "static" = fixed hand-authored routes (strategies.json), for a known-good route.
  scanMode: (process.env.SCAN_MODE ?? "dynamic").toLowerCase(),
  // "block" = re-evaluate on every new block (continuous - requirement: "evaluate
  //   opportunities continuously"). Needs a WebSocket-capable RPC_URL (wss://...);
  //   falls back to polling automatically if the provider doesn't support subscriptions.
  // "poll" = fixed-interval polling (POLL_INTERVAL_MS) - works with any RPC, including
  //   plain HTTP endpoints that can't push block notifications.
  triggerMode: (process.env.TRIGGER_MODE ?? "poll").toLowerCase(),
  strategiesFile: process.env.STRATEGIES_FILE ?? "./strategies.json",
  routesConfigFile: process.env.ROUTES_CONFIG_FILE ?? "./routes.config.json",
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 6000),
  dryRun,
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

export function loadRoutesConfig(): RoutesConfigFile {
  const raw = readFileSync(config.routesConfigFile, "utf-8");
  const parsed = JSON.parse(raw) as RoutesConfigFile;
  if (!parsed.baseAssets?.length || !parsed.routers?.length) {
    throw new Error(`Invalid or empty routes config in ${config.routesConfigFile}`);
  }
  return parsed;
}
