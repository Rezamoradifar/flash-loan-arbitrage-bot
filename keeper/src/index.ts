import { Contract, JsonRpcProvider, Wallet } from "ethers";
import { EXECUTOR_ABI } from "./abi.js";
import { config } from "./config.js";
import { runKeeper } from "./keeper.js";

/**
 * Entry point only: wires up the provider/wallet/contract, verifies the
 * configured wallet is actually authorized on-chain, then hands off to
 * keeper.ts. Scanning/ranking logic lives in scanner.ts, execution
 * orchestration in keeper.ts, metrics in metrics.ts, route generation in
 * routes.ts - see ARCHITECTURE.md for how these pieces fit together.
 */
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

  await runKeeper(executor, provider);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
