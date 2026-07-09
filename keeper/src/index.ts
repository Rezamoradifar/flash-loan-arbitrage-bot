import { Contract, JsonRpcProvider, Wallet } from "ethers";
import { EXECUTOR_ABI } from "./abi.js";
import { config } from "./config.js";
import { runKeeper } from "./keeper.js";

/**
 * Entry point only: wires up the provider/wallet/contract, verifies the
 * configured wallet is actually authorized on-chain (when there is one to
 * check), then hands off to keeper.ts. Scanning/ranking logic lives in
 * scanner.ts, execution orchestration in keeper.ts, metrics in metrics.ts,
 * route generation in routes.ts - see ARCHITECTURE.md.
 *
 * DRY_RUN=true needs neither PRIVATE_KEY nor EXECUTOR_ADDRESS (config.ts
 * only requires them when DRY_RUN=false): a pure simulate-and-log run reads
 * DEX state over RPC and never signs or broadcasts anything, so there's
 * nothing for a wallet or a deployed contract to do. When either is missing,
 * `wallet`/`executor` below are undefined/null and every read that would
 * normally hit the deployed contract falls back to local estimates instead
 * (see scanner.ts) - dynamic-mode scanning still works fully; static mode
 * (which relies entirely on the contract's own on-chain quoting logic) still
 * requires EXECUTOR_ADDRESS even in dry-run, and says so clearly if it's missing.
 */
async function main() {
  const provider = new JsonRpcProvider(config.rpcUrl);
  const wallet = config.privateKey ? new Wallet(config.privateKey, provider) : undefined;
  const executor = config.executorAddress
    ? new Contract(config.executorAddress, EXECUTOR_ABI, wallet ?? provider)
    : null;

  const network = await provider.getNetwork();
  console.log(`Connected to chainId=${network.chainId} as keeper=${wallet ? wallet.address : "(none - DRY_RUN simulate-only, no PRIVATE_KEY set)"}`);
  console.log(
    `Executor: ${config.executorAddress ?? "(none - DRY_RUN simulate-only, no EXECUTOR_ADDRESS set)"}  mode=${config.scanMode}  dryRun=${config.dryRun}`
  );

  if (wallet && executor) {
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
  } else if (!config.dryRun) {
    // config.ts already throws before we get here in this case, but fail
    // loudly instead of silently proceeding if that ever changes.
    throw new Error("PRIVATE_KEY and EXECUTOR_ADDRESS are both required when DRY_RUN=false.");
  } else {
    console.log("Simulate-only mode: no on-chain authorization check to run (no wallet and/or no executor configured).");
  }

  await runKeeper(executor, provider);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
