import { Contract, JsonRpcProvider, Wallet } from "ethers";
import { EXECUTOR_ABI } from "./abi.js";
import { config, loadRoutesConfig, loadStrategies, type StrategyConfig } from "./config.js";
import { generateCandidateRoutes, type RouteCandidate } from "./routes.js";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function runStaticMode(executor: Contract) {
  const { asset, strategies } = loadStrategies();
  const amount = BigInt(asset.flashLoanAmount);
  console.log(`[static] Loaded ${strategies.length} strategy(ies) for asset ${asset.symbol} (${asset.address})`);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    for (const strategy of strategies) {
      await evaluateStaticStrategy(executor, asset.address, amount, strategy);
    }
    await sleep(config.pollIntervalMs);
  }
}

// ============================================================
// Dynamic mode: multi-DEX, multi-asset, multi-hop auto-scanner
// ============================================================

async function evaluateCandidate(
  executor: Contract,
  provider: JsonRpcProvider,
  candidate: RouteCandidate,
  amount: bigint,
  cfg: ReturnType<typeof loadRoutesConfig>
) {
  const steps = candidate.hops.map(hopTuple);

  // 1) Gross output already reflects every hop's swap fee (baked into each
  //    DEX's own getAmountsOut quote) - that's cost #2 (swap fees) handled.
  //    Apply an off-chain slippage buffer haircut on top of that: a real
  //    quote can move between "quoted now" and "transaction lands" - this is
  //    deliberately separate from executeArbitrage's own on-chain
  //    amountOutMin/slippageBPS tolerance, which only protects the
  //    *execution*, not this *pre-trade filtering* decision.
  const grossOutAfterBuffer = (candidate.grossOut * BigInt(10_000 - cfg.slippageBufferBps)) / 10_000n;

  // 2) Flash loan premium (cost #1).
  const premium: bigint = await executor.estimateFlashLoanFee(amount);
  const afterPremium = grossOutAfterBuffer - amount - premium;
  if (afterPremium <= 0n) {
    console.log(`[${candidate.name}] negative after premium+slippage-buffer, skipping`);
    return;
  }

  // 3) Gas cost (cost #3), converted to the borrowed asset's terms via the
  //    contract's own Chainlink-fed helper. Requires setPriceFeed() to be
  //    configured on-chain for both wrappedNative and this base asset; if
  //    either is missing the helper returns 0 and we log a warning instead
  //    of silently treating gas as free.
  const feeData = await provider.getFeeData();
  const gasPriceWei = feeData.gasPrice ?? 0n;
  let gasCostInAsset = 0n;
  try {
    gasCostInAsset = await executor.estimateGasCostInAsset(
      candidate.baseAsset.address,
      cfg.wrappedNative.address,
      cfg.gasUnitsPerTrade,
      gasPriceWei
    );
  } catch {
    // leave at 0
  }
  if (gasCostInAsset === 0n) {
    console.log(
      `[${candidate.name}] WARNING: gas cost unknown (price feeds not set for ${candidate.baseAsset.symbol} and/or ${cfg.wrappedNative.symbol}) - treating gas as 0 for this filter. Configure setPriceFeed() on-chain for accurate gas-aware filtering.`
    );
  }

  const netProfit = afterPremium - gasCostInAsset;

  // 4) Reject any trade with negative or insufficient net profit (requirement #7),
  //    using the PER-ASSET threshold (requirement #8), not one global number.
  const minProfit = BigInt(cfg.minProfitByAssetAddress[candidate.baseAsset.address] ?? "0");
  if (netProfit < minProfit) {
    if (netProfit > 0n) {
      console.log(`[${candidate.name}] profitable but below threshold: net=${netProfit} < min=${minProfit}`);
    }
    return;
  }

  console.log(
    `[${candidate.name}] PROFITABLE after premium+fees+gas+slippage-buffer: net=${netProfit} ${candidate.baseAsset.symbol}`
  );
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

  // eslint-disable-next-line no-constant-condition
  while (true) {
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

    await sleep(config.pollIntervalMs);
  }
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
    await runStaticMode(executor);
  } else {
    await runDynamicMode(executor, provider);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
