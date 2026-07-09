import { Contract, type JsonRpcProvider } from "ethers";
import type { RoutesConfigFile } from "./config.js";
import { generateCandidateRoutes, type RouteCandidate } from "./routes.js";
import type { Metrics } from "./metrics.js";

export function hopTuple(h: {
  router: string;
  quoter: string;
  routerType: number;
  tokenIn: string;
  tokenOut: string;
  v3Fee: number;
  stableI: number;
  stableJ: number;
}) {
  return [h.router, h.quoter, h.routerType, h.tokenIn, h.tokenOut, h.v3Fee, h.stableI, h.stableJ] as const;
}

export interface DecisionBreakdown {
  candidate: string;
  baseAsset: string;
  amount: string;
  grossOut: string;
  afterSlippageBuffer: string;
  premium: string;
  afterPremium: string;
  gasCostInAsset: string;
  gasCostKnown: boolean;
  netProfit: string;
  minProfitThreshold: string;
  decision: "ACCEPTED" | "REJECTED";
  reason: string;
  rejectCategory?: string;
}

/** One fully-evaluated candidate, ranked and ready for a keeper to act on -
 *  this is the "opportunity" in the scanner's ranked-list output. `breakdown`
 *  is omitted for opportunities built outside the dynamic scanner (e.g.
 *  static-mode strategies), which don't go through the same cost breakdown. */
export interface Opportunity {
  candidate: RouteCandidate;
  amount: bigint;
  steps: ReturnType<typeof hopTuple>[];
  minProfit: bigint;
  slippageBps: number;
  netProfit: bigint;
  executable: boolean;
  breakdown?: DecisionBreakdown;
}

const VERBOSE_LOGS = (process.env.VERBOSE_LOGS ?? "false").toLowerCase() === "true";
const LOG_REJECTED = (process.env.LOG_REJECTED ?? "true").toLowerCase() === "true";

/** Requirement: detailed logs explaining why each opportunity is accepted or
 *  rejected. One structured line per candidate (VERBOSE_LOGS=true switches to
 *  a pretty multi-line breakdown) - every number that fed the decision is
 *  present, not just the final verdict. */
function logDecision(b: DecisionBreakdown) {
  if (b.decision === "REJECTED" && !LOG_REJECTED) return;
  if (VERBOSE_LOGS) {
    console.log(`\n=== [${b.decision}] ${b.candidate} (${b.reason}) ===`);
    console.log(`  base asset:            ${b.baseAsset}`);
    console.log(`  amount borrowed:       ${b.amount}`);
    console.log(`  gross cycle output:    ${b.grossOut}  (already net of every hop's swap fee)`);
    console.log(`  after slippage buffer: ${b.afterSlippageBuffer}`);
    console.log(`  flash-loan premium:    ${b.premium}`);
    console.log(`  after premium:         ${b.afterPremium}`);
    console.log(
      `  gas cost (in asset):   ${b.gasCostInAsset}${b.gasCostKnown ? "" : "  (UNKNOWN - price feeds not set, treated as 0)"}`
    );
    console.log(`  net profit:            ${b.netProfit}`);
    console.log(`  min profit threshold:  ${b.minProfitThreshold}`);
  } else {
    console.log(
      `[${b.decision}] ${b.candidate} | gross=${b.grossOut} premium=${b.premium} gas=${b.gasCostInAsset}${b.gasCostKnown ? "" : "(?)"} net=${b.netProfit} min=${b.minProfitThreshold} | ${b.reason}`
    );
  }
}

/** Mirrors AaveArbitrageExecutorV3.estimateFlashLoanFee(): Aave V3's flash-loan
 *  premium is a fixed, publicly-known 0.05% of the borrowed amount - it isn't
 *  deployment-specific configuration, so it's safe to replicate locally when
 *  no executor contract is available to ask (DRY_RUN=true, no EXECUTOR_ADDRESS). */
function localFlashLoanFeeEstimate(amount: bigint): bigint {
  return (amount * 5n) / 10_000n;
}

async function evaluateCandidate(
  executor: Contract | null,
  provider: JsonRpcProvider,
  candidate: RouteCandidate,
  amount: bigint,
  cfg: RoutesConfigFile,
  metrics: Metrics
): Promise<Opportunity> {
  metrics.recordEvaluated();
  const steps = candidate.hops.map(hopTuple);
  const minProfit = BigInt(cfg.minProfitByAssetAddress[candidate.baseAsset.address] ?? "0");

  const breakdown: Partial<DecisionBreakdown> = {
    candidate: candidate.name,
    baseAsset: candidate.baseAsset.symbol,
    amount: amount.toString(),
    grossOut: candidate.grossOut.toString(),
    minProfitThreshold: minProfit.toString(),
  };

  const rejected = (netProfit: bigint, reason: string, rejectCategory: string, extra: Partial<DecisionBreakdown> = {}): Opportunity => {
    metrics.recordRejected(rejectCategory);
    const full = {
      afterSlippageBuffer: "-",
      premium: "-",
      afterPremium: "-",
      gasCostInAsset: "0",
      gasCostKnown: true,
      netProfit: netProfit.toString(),
      decision: "REJECTED" as const,
      reason,
      rejectCategory,
      ...breakdown,
      ...extra,
    } as DecisionBreakdown;
    logDecision(full);
    return {
      candidate,
      amount,
      steps,
      minProfit,
      slippageBps: cfg.executionSlippageBps,
      netProfit,
      executable: false,
      breakdown: full,
    };
  };

  // 1) Gross output already reflects every hop's swap fee (baked into each
  //    DEX's own getAmountsOut/quoteExactInputSingle/quotePotentialSwap quote)
  //    - that's cost #2 (swap fees) handled. Apply an off-chain slippage
  //    buffer haircut on top of that: a real quote can move between "quoted
  //    now" and "transaction lands" - this is deliberately separate from
  //    executeArbitrage's own on-chain amountOutMin/slippageBPS tolerance,
  //    which only protects the *execution*, not this *pre-trade filtering*
  //    decision.
  const grossOutAfterBuffer = (candidate.grossOut * BigInt(10_000 - cfg.slippageBufferBps)) / 10_000n;
  breakdown.afterSlippageBuffer = grossOutAfterBuffer.toString();

  // 2) Flash loan premium (cost #1). Falls back to a local replica of the
  //    fixed 0.05% Aave V3 rate when there's no deployed contract to ask
  //    (DRY_RUN=true, no EXECUTOR_ADDRESS) - see localFlashLoanFeeEstimate.
  const premium: bigint = executor ? await executor.estimateFlashLoanFee(amount) : localFlashLoanFeeEstimate(amount);
  breakdown.premium = premium.toString();
  const afterPremium = grossOutAfterBuffer - amount - premium;
  breakdown.afterPremium = afterPremium.toString();
  if (afterPremium <= 0n) {
    return rejected(afterPremium, "negative after flash-loan premium + slippage buffer, before gas is even considered", "negative-after-premium");
  }

  // 3) Gas cost (cost #3), converted to the borrowed asset's terms via the
  //    contract's own Chainlink-fed helper. Requires an actual deployed
  //    contract AND setPriceFeed() configured on-chain for both
  //    wrappedNative and this base asset; if any of that is missing (no
  //    executor at all, or feeds not set) gasCostKnown=false flags that in
  //    the log instead of silently treating gas as free.
  const feeData = await provider.getFeeData();
  const gasPriceWei = feeData.gasPrice ?? 0n;
  let gasCostInAsset = 0n;
  let gasCostKnown = true;
  if (!executor) {
    gasCostKnown = false; // no deployed contract/price feeds to query - simulate-only mode
  } else {
    try {
      gasCostInAsset = await executor.estimateGasCostInAsset(
        candidate.baseAsset.address,
        cfg.wrappedNative.address,
        cfg.gasUnitsPerTrade,
        gasPriceWei
      );
      gasCostKnown = gasCostInAsset > 0n;
    } catch {
      gasCostKnown = false;
    }
  }

  const netProfit = afterPremium - gasCostInAsset;
  breakdown.gasCostInAsset = gasCostInAsset.toString();
  breakdown.netProfit = netProfit.toString();

  // 4) Reject any trade with negative or insufficient net profit (requirement:
  //    "execute only when expected net profit exceeds a configurable
  //    threshold"), using the PER-ASSET threshold, not one global number.
  if (netProfit < minProfit) {
    return rejected(
      netProfit,
      netProfit <= 0n
        ? "net profit is negative after premium + gas"
        : `net profit ${netProfit} is below the configured minimum ${minProfit} for ${candidate.baseAsset.symbol}`,
      netProfit <= 0n ? "negative-after-gas" : "below-threshold",
      { gasCostKnown }
    );
  }

  metrics.recordAccepted(candidate.baseAsset.symbol, netProfit);
  const accepted: DecisionBreakdown = {
    ...breakdown,
    gasCostKnown,
    decision: "ACCEPTED",
    reason: "net profit clears premium + fees + gas + slippage buffer + per-asset threshold",
  } as DecisionBreakdown;
  logDecision(accepted);

  return {
    candidate,
    amount,
    steps,
    minProfit,
    slippageBps: cfg.executionSlippageBps,
    netProfit,
    executable: true,
    breakdown: accepted,
  };
}

/**
 * Runs one full scan cycle: generates candidate routes across every
 * configured DEX/asset/hop combination, evaluates each for full-cost net
 * profitability, and returns ALL of them ranked (highest net profit first) -
 * "a ranked list of opportunities". Only entries with `executable: true`
 * cleared every cost + the per-asset threshold; the caller (keeper.ts)
 * decides what to do with the ranked list.
 */
export async function runScanCycle(
  executor: Contract | null,
  provider: JsonRpcProvider,
  cfg: RoutesConfigFile,
  probes: Record<string, bigint>,
  metrics: Metrics
): Promise<Opportunity[]> {
  const started = Date.now();
  let candidates: RouteCandidate[] = [];
  try {
    candidates = await generateCandidateRoutes(
      provider,
      cfg.baseAssets,
      cfg.intermediateTokens,
      cfg.routers,
      probes,
      cfg.maxPriceImpactBps ?? 0
    );
  } catch (err) {
    console.error(`Route generation failed: ${(err as Error).message}`);
  }
  console.log(`[scanner] Generated ${candidates.length} candidate route(s) in ${Date.now() - started}ms`);

  const opportunities: Opportunity[] = [];
  for (const candidate of candidates) {
    const amount = probes[candidate.baseAsset.address.toLowerCase()];
    if (!amount) continue;
    try {
      opportunities.push(await evaluateCandidate(executor, provider, candidate, amount, cfg, metrics));
    } catch (err) {
      console.log(`[${candidate.name}] evaluation error: ${(err as Error).message.slice(0, 200)}`);
    }
  }

  opportunities.sort((a, b) => (b.netProfit > a.netProfit ? 1 : b.netProfit < a.netProfit ? -1 : 0));

  const executableCount = opportunities.filter((o) => o.executable).length;
  const topN = opportunities.slice(0, 5);
  if (topN.length > 0) {
    console.log(`[scanner] Ranked top ${topN.length} candidate(s) this cycle (${executableCount} executable):`);
    topN.forEach((o, i) => {
      console.log(
        `  #${i + 1} ${o.executable ? "✅" : "  "} ${o.candidate.name} — net=${o.netProfit} ${o.candidate.baseAsset.symbol}`
      );
    });
  }

  metrics.recordScanDuration(Date.now() - started);
  console.log(metrics.summary());

  return opportunities;
}
