import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { http } from "wagmi";
import { bsc } from "wagmi/chains";

/**
 * WalletConnect requires a projectId for its relay - get a free one at
 * https://cloud.reown.com and set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID.
 * Without it, MetaMask/injected/Coinbase wallet connections still work
 * (they don't go through WalletConnect's relay); only the WalletConnect
 * QR-code option itself will fail when actually used - it won't block app
 * startup or any other wallet. The placeholder below is a syntactically
 * valid-looking (32 hex chars) but non-functional ID, matching the shape
 * Reown/WalletConnect actually issues, so its connector initializes cleanly
 * instead of erroring on a malformed value.
 */
const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "";
if (!walletConnectProjectId && process.env.NODE_ENV !== "production") {
  console.warn(
    "[wagmiConfig] NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is not set - the WalletConnect QR-code option will not work. Get a free project ID at https://cloud.reown.com."
  );
}
const PLACEHOLDER_PROJECT_ID = "00000000000000000000000000000000".slice(0, 32);

/**
 * Falls back to a CORS-friendly public BSC RPC (PublicNode) when
 * NEXT_PUBLIC_RPC_URL is unset, rather than viem's own baked-in chain
 * default (bsc-dataseed.binance.org), which frequently rejects or hangs on
 * direct browser requests (no permissive CORS headers, aggressive rate
 * limiting) - that mismatch is a common cause of "every page stuck loading"
 * reports. Set your own paid endpoint (Ankr/QuickNode/NodeReal) for real
 * production traffic; the public fallback is fine for light/dev use only.
 */
const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL || "https://bsc-rpc.publicnode.com";

export const wagmiConfig = getDefaultConfig({
  appName: "Aave Arbitrage Executor",
  projectId: walletConnectProjectId || PLACEHOLDER_PROJECT_ID,
  chains: [bsc],
  transports: {
    [bsc.id]: http(rpcUrl, {
      // Explicit, generous but bounded timeout + a couple of retries -
      // without this, a slow/misbehaving RPC can make every read feel
      // "stuck" for far longer than necessary before finally erroring.
      timeout: 15_000,
      retryCount: 2,
      retryDelay: 1_000,
    }),
  },
  // wagmi's default (true) silently batches every useReadContract/
  // useReadContracts call that fires in the same tick into ONE eth_call to
  // the Multicall3 contract. If that contract isn't deployed at the
  // canonical address on whatever endpoint NEXT_PUBLIC_RPC_URL points at
  // (a local devnet, a misconfigured private node, some proxy/relay that
  // doesn't forward calls to it correctly), every batched read comes back
  // as an empty "0x" result - not an error, just permanently missing data
  // with nothing in the UI to explain why. Confirmed via a real local-anvil
  // test: owner/keeper/profitRecipient reads all silently returned
  // undefined with multicall on, and resolved correctly with it off. Real
  // BSC mainnet does have Multicall3 at the standard address, so this only
  // costs a few extra parallel RPC calls per page in production - a small
  // price for every read failure mode being a real, visible error instead
  // of a silent blank.
  batch: { multicall: false },
  ssr: true,
});
