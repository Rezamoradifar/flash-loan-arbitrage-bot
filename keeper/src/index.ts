import { Contract, JsonRpcProvider, Wallet } from "ethers";
import { EXECUTOR_ABI } from "./abi.js";
import { config, loadRoutesConfig, loadStrategies, type StrategyConfig } from "./config.js";
import { generateCandidateRoutes, type RouteCandidate } from "./routes.js";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Drives continuous evaluation (requirement: "evaluate opportunities
 * continuously") one of two ways:
 *  - TRIGGER_MODE=block: subscribes to new blocks via the provider and
 *    re-scans on every one. Works over both a WebSocket RPC_URL (true push
 *    subscription) and a plain HTTP RPC_URL (ethers transparently emulates
 *    it by polling eth_blockNumber) - no branching needed here either way.
 *  - TRIGGER_MODE=poll (default): fixed-interval loop, safest choice against
 *    a rate-limited public RPC since the interval is fully under your control.
 * A `running` guard prevents overlapping scans if a new block arrives (or
 * the interval fires again) before the previous scan finished.
 */
async function runWithTrigger(provider: JsonRpcProvider, scanOnce: () => Promise<void>) {
  let running = false;
  const tick = async () => {
    if (running) return; // still working on the previous block/tick - skip, don't queue up
    running = true;
    try {
      await scanOnce();
    } catch (err) {
      console.error(`Scan failed: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  };

  if (config.triggerMode === "block") {
    console.log("[trigger] mode=block - re-scanning on every new block");
    provider.on("block", () => void tick());
    await tick(); // don't wait for the first block to do an initial scan
    // keep the process alive; the block listener drives everything from here
    await new Promise(() => {});
  } else {
    console.log(`[trigger] mode=poll - re-scanning every ${config.pollIntervalMs}ms`);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await tick();
      await sleep(config.pollIntervalMs);
    }
  }
}

function hopTuple(h: { router: string; quoter: string; routerType: number; tokenIn: string; tokenOut: string; v3Fee: number; stableI: number; stableJ: number }) {
  return [h.router, h.quoter, h.routerType, h.tokenIn, h.tokenOut, h.v3Fee, h.stableI, h.stableJ] as const;
}

// ============================================================
// Static mode: fixed, hand-authored routes from strategies.json
// ============================================================

async function evaluateStaticStrategy(
  executor: Contract,
  asset: string,
  amount: bigint,
  strategy: StrategyConfig
) {
  const steps = strategy.hops.map(hopTuple);
  const minProfit =
    BigInt(strategy.minProfitOverride || "0") > config.minNetProfit
      ? BigInt(strategy.minProfitOverride || "0")
      : config.minNetProfit;

  let netProfit: bigint;
  try {
    netProfit = await executor.expectedNetProfit.staticCall(asset, amount, steps);
  } catch (err) {
    console.log(`[${strategy.name}] quote failed: ${(err as Error).message.slice(0, 200)}`);
    return;
  }

  if (netProfit < minProfit) {
    console.log(`[${strategy.name}] not profitable enough: netProfit=${netProfit} < min=${minProfit}`);
    return;
  }

  console.log(`[${strategy.name}] PROFITABLE: expected net profit = ${netProfit}`);
  await maybeSubmit(
    executor,
    strategy.name,
    asset,
    amount,
    steps,
    minProfit,
    strategy.slippageBpsOverride || config.slippageBps
  );
}

async function runStaticMode(executor: Contract, provider: JsonRpcProvider) {
  const { asset, strategies } = loadStrategies();
  const amount = BigInt(asset.flashLoanAmount);
  console.log(`[static] Loaded ${strategies.length} strategy(ies) for asset ${asset.symbol} (${asset.address})`);

  await runWithTrigger(provider, async () => {
    for (const strategy of strategies) {
      await evaluateStaticStrategy(executor, asset.address, amount, strategy);
    }
  });
}

// ============================================================
// Dynamic mode: multi-DEX, multi-asset, multi-hop auto-scanner
// ============================================================

const VERBOSE_LOGS = (process.env.VERBOSE_LOGS ?? "false").toLowerCase() === "true";
const LOG_REJECTED = (process.env.LOG_REJECTED ?? "true").toLowerCase() === "true";

interface DecisionBreakdown {
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
}

/** Requirement: detailed logs explaining why each opportunity is accepted or
 *  rejected. One structured line per candidate (VERBOSE_LOGS=true switches to
 *  pretty multi-line) - every number that fed the decision is present, not
 *  just the final verdict. */
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
    console.log(`  gas cost (in asset):   ${b.gasCostInAsset}${b.gasCostKnown ? "" : "  (UNKNOWN - price feeds not set, treated as 0)"}`);
    console.log(`  net profit:            ${b.netProfit}`);
    console.log(`  min profit threshold:  ${b.minProfitThreshold}`);
  } else {
    console.log(
      `[${b.decision}] ${b.candidate} | gross=${b.grossOut} premium=${b.premium} gas=${b.gasCostInAsset}${b.gasCostKnown ? "" : "(?)"} net=${b.netProfit} min=${b.minProfitThreshold} | ${b.reason}`
    );
  }
}

async function evaluateCandidate(
  executor: Contract,
  provider: JsonRpcProvider,
  candidate: RouteCandidate,
  amount: bigint,
  cfg: ReturnType<typeof loadRoutesConfig>
) {
  const steps = candidate.hops.map(hopTuple);
  const minProfit = BigInt(cfg.minProfitByAssetAddress[candidate.baseAsset.address] ?? "0");

  const breakdown: Partial<DecisionBreakdown> = {
    candidate: candidate.name,
    baseAsset: candidate.baseAsset.symbol,
    amount: amount.toString(),
    grossOut: candidate.grossOut.toString(),
    minProfitThreshold: minProfit.toString(),
  };
  const reject = (reason: string, extra: Partial<DecisionBreakdown> = {}) => {
    logDecision({
      afterSlippageBuffer: "-",
      premium: "-",
      afterPremium: "-",
      gasCostInAsset: "0",
      gasCostKnown: true,
      netProfit: "-",
      decision: "REJECTED",
      reason,
      ...breakdown,
      ...extra,
    } as DecisionBreakdown);
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

  // 2) Flash loan premium (cost #1).
  const premium: bigint = await executor.estimateFlashLoanFee(amount);
  breakdown.premium = premium.toString();
  const afterPremium = grossOutAfterBuffer - amount - premium;
  breakdown.afterPremium = afterPremium.toString();
  if (afterPremium <= 0n) {
    reject("negative after flash-loan premium + slippage buffer, before gas is even considered");
    return;
  }

  // 3) Gas cost (cost #3), converted to the borrowed asset's terms via the
  //    contract's own Chainlink-fed helper. Requires setPriceFeed() to be
  //    configured on-chain for both wrappedNative and this base asset; if
  //    either is missing the helper returns 0 and gasCostKnown=false flags
  //    that in the log instead of silently treating gas as free.
  const feeData = await provider.getFeeData();
  const gasPriceWei = feeData.gasPrice ?? 0n;
  let gasCostInAsset = 0n;
  let gasCostKnown = true;
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

  const netProfit = afterPremium - gasCostInAsset;
  breakdown.gasCostInAsset = gasCostInAsset.toString();
  breakdown.netProfit = netProfit.toString();

  // 4) Reject any trade with negative or insufficient net profit (requirement #7),
  //    using the PER-ASSET threshold (requirement #8), not one global number.
  if (netProfit < minProfit) {
    reject(
      netProfit <= 0n
        ? "net profit is negative after premium + gas"
        : `net profit ${netProfit} is below the configured minimum ${minProfit} for ${candidate.baseAsset.symbol}`,
      { gasCostKnown }
    );
    return;
  }

  logDecision({
    ...breakdown,
    gasCostKnown,
    decision: "ACCEPTED",
    reason: "net profit clears premium + fees + gas + slippage buffer + per-asset threshold",
  } as DecisionBreakdown);

  await maybeSubmit(
    executor,
    candidate.name,
    candidate.baseAsset.address,
    amount,
    steps,
    minProfit,
    cfg.executionSlippageBps
  );
}

async function runDynamicMode(executor: Contract, provider: JsonRpcProvider) {
  const cfg = loadRoutesConfig();
  console.log(
    `[dynamic] Scanning ${cfg.baseAssets.length} base asset(s) x ${cfg.intermediateTokens.length} token(s) x ${cfg.routers.length} router(s)`
  );

  const probes: Record<string, bigint> = {};
  for (const [addr, amt] of Object.entries(cfg.probeAmountByAssetAddress)) {
    probes[addr.toLowerCase()] = BigInt(amt);
  }

  await runWithTrigger(provider, async () => {
    const started = Date.now();
    let candidates: RouteCandidate[] = [];
    try {
      candidates = await generateCandidateRoutes(
        provider,
        cfg.baseAssets,
        cfg.intermediateTokens,
        cfg.routers,
        probes
      );
    } catch (err) {
      console.error(`Route generation failed: ${(err as Error).message}`);
    }
    console.log(`[dynamic] Generated ${candidates.length} candidate route(s) in ${Date.now() - started}ms`);

    for (const candidate of candidates) {
      const amount = probes[candidate.baseAsset.address.toLowerCase()];
      if (!amount) continue;
      try {
        await evaluateCandidate(executor, provider, candidate, amount, cfg);
      } catch (err) {
        console.log(`[${candidate.name}] evaluation error: ${(err as Error).message.slice(0, 200)}`);
      }
    }
  });
}

// ============================================================
// Shared submission path
// ============================================================

async function maybeSubmit(
  executor: Contract,
  name: string,
  asset: string,
  amount: bigint,
  steps: ReturnType<typeof hopTuple>[],
  minProfit: bigint,
  slippageBps: number
) {
  if (config.dryRun) {
    console.log(`[${name}] DRY_RUN=true, not sending a transaction.`);
    return;
  }
  try {
    const tx = await executor.executeArbitrage(asset, amount, steps, minProfit, slippageBps);
    console.log(`[${name}] submitted tx ${tx.hash}, waiting for confirmation...`);
    const receipt = await tx.wait();
    console.log(`[${name}] confirmed in block ${receipt.blockNumber}, status=${receipt.status}`);
  } catch (err) {
    console.error(`[${name}] executeArbitrage failed: ${(err as Error).message}`);
  }
}

// ============================================================
// Entry point
// ============================================================

async function main() {
  const provider = new JsonRpcProvider(config.rpcUrl);
  const wallet = new Wallet(config.privateKey, provider);
  const executor = new Contract(config.executorAddress, EXECUTOR_ABI, wallet);

  const network = await provider.getNetwork();
  console.log(`Connected to chainId=${network.chainId} as keeper=${wallet.address}`);
  console.log(`Executor: ${config.executorAddress}  mode=${config.scanMode}  dryRun=${config.dryRun}`);

  const onChainKeeper: string = await executor.keeper();
  const onChainOwner: string = await executor.owner();
  if (
    wallet.address.toLowerCase() !== onChainKeeper.toLowerCase() &&
    wallet.address.toLowerCase() !== onChainOwner.toLowerCase()
  ) {
    throw new Error(
      `Wallet ${wallet.address} is neither the contract's keeper (${onChainKeeper}) nor owner (${onChainOwner}) - executeArbitrage would revert.`
    );
  }

  if (config.scanMode === "static") {
    await runStaticMode(executor, provider);
  } else {
    await runDynamicMode(executor, provider);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
