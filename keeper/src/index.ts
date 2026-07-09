import { Contract, JsonRpcProvider, Wallet } from "ethers";
import { EXECUTOR_ABI } from "./abi.js";
import { config, loadStrategies, type StrategyConfig } from "./config.js";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hopTuple(h: StrategyConfig["hops"][number]) {
  return [h.router, h.quoter, h.routerType, h.tokenIn, h.tokenOut, h.v3Fee, h.stableI, h.stableJ] as const;
}

async function evaluateAndMaybeExecute(
  executor: Contract,
  asset: string,
  amount: bigint,
  strategy: StrategyConfig
) {
  const steps = strategy.hops.map(hopTuple);
  const minProfit = BigInt(strategy.minProfitOverride || "0") > config.minNetProfit
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

  if (config.dryRun) {
    console.log(`[${strategy.name}] DRY_RUN=true, not sending a transaction.`);
    return;
  }

  const slippageBps = strategy.slippageBpsOverride || config.slippageBps;
  try {
    const tx = await executor.executeArbitrage(asset, amount, steps, minProfit, slippageBps);
    console.log(`[${strategy.name}] submitted tx ${tx.hash}, waiting for confirmation...`);
    const receipt = await tx.wait();
    console.log(`[${strategy.name}] confirmed in block ${receipt.blockNumber}, status=${receipt.status}`);
  } catch (err) {
    console.error(`[${strategy.name}] executeArbitrage failed: ${(err as Error).message}`);
  }
}

async function main() {
  const provider = new JsonRpcProvider(config.rpcUrl);
  const wallet = new Wallet(config.privateKey, provider);
  const executor = new Contract(config.executorAddress, EXECUTOR_ABI, wallet);

  const network = await provider.getNetwork();
  console.log(`Connected to chainId=${network.chainId} as keeper=${wallet.address}`);
  console.log(`Executor: ${config.executorAddress}  dryRun=${config.dryRun}`);

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

  const { asset, strategies } = loadStrategies();
  const amount = BigInt(asset.flashLoanAmount);
  console.log(`Loaded ${strategies.length} strategy(ies) for asset ${asset.symbol} (${asset.address})`);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    for (const strategy of strategies) {
      await evaluateAndMaybeExecute(executor, asset.address, amount, strategy);
    }
    await sleep(config.pollIntervalMs);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
