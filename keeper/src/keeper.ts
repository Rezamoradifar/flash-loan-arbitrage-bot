import { Contract, JsonRpcProvider } from "ethers";
import { config, loadRoutesConfig, loadStrategies, type StrategyConfig } from "./config.js";
import { Metrics } from "./metrics.js";
import { hopTuple, runScanCycle, type Opportunity } from "./scanner.js";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Drives continuous evaluation (requirement: "watches every new block" /
 * "evaluate opportunities continuously") one of two ways:
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
    await new Promise(() => {}); // keep the process alive; the block listener drives everything now
  } else {
    console.log(`[trigger] mode=poll - re-scanning every ${config.pollIntervalMs}ms`);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await tick();
      await sleep(config.pollIntervalMs);
    }
  }
}

async function submitOpportunity(executor: Contract, o: Opportunity) {
  if (config.dryRun) {
    console.log(`[${o.candidate.name}] DRY_RUN=true, not sending a transaction. Would submit net=${o.netProfit}.`);
    return;
  }
  try {
    const tx = await executor.executeArbitrage(o.candidate.baseAsset.address, o.amount, o.steps, o.minProfit, o.slippageBps);
    console.log(`[${o.candidate.name}] submitted tx ${tx.hash}, waiting for confirmation...`);
    const receipt = await tx.wait();
    console.log(`[${o.candidate.name}] confirmed in block ${receipt.blockNumber}, status=${receipt.status}`);
  } catch (err) {
    console.error(`[${o.candidate.name}] executeArbitrage failed: ${(err as Error).message}`);
  }
}

// ============================================================
// Static mode: fixed, hand-authored routes from strategies.json
// ============================================================

async function evaluateStaticStrategy(executor: Contract, asset: string, amount: bigint, strategy: StrategyConfig) {
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
    console.log(`[${strategy.name}] REJECTED: netProfit=${netProfit} < min=${minProfit}`);
    return;
  }

  console.log(`[${strategy.name}] ACCEPTED: expected net profit = ${netProfit}`);
  await submitOpportunity(executor, {
    candidate: { name: strategy.name, baseAsset: { symbol: "", address: asset, decimals: 18 }, hops: [], grossOut: 0n },
    amount,
    steps,
    minProfit,
    slippageBps: strategy.slippageBpsOverride || config.slippageBps,
    netProfit,
    executable: true,
  });
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
// Dynamic mode: scanner produces a ranked list, keeper executes the best one
// ============================================================

async function runDynamicMode(executor: Contract, provider: JsonRpcProvider) {
  const cfg = loadRoutesConfig();
  console.log(
    `[dynamic] Scanning ${cfg.baseAssets.length} base asset(s) x ${cfg.intermediateTokens.length} token(s) x ${cfg.routers.length} router(s)`
  );

  const probes: Record<string, bigint> = {};
  for (const [addr, amt] of Object.entries(cfg.probeAmountByAssetAddress)) {
    probes[addr.toLowerCase()] = BigInt(amt);
  }

  const metrics = new Metrics();

  await runWithTrigger(provider, async () => {
    const opportunities = await runScanCycle(executor, provider, cfg, probes, metrics);

    // executeArbitrage has an on-chain same-block replay guard, so only one
    // execution can land per block regardless - submit just the single best
    // ranked opportunity each cycle (opportunities[0] after sorting).
    const best = opportunities.find((o) => o.executable);
    if (best) {
      await submitOpportunity(executor, best);
    }
  });
}

export async function runKeeper(executor: Contract, provider: JsonRpcProvider) {
  if (config.scanMode === "static") {
    await runStaticMode(executor, provider);
  } else {
    await runDynamicMode(executor, provider);
  }
}
