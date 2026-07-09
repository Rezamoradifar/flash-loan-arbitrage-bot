import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { http } from "wagmi";
import { bsc } from "wagmi/chains";

/**
 * WalletConnect requires a projectId for its relay - get a free one at
 * https://cloud.reown.com and set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID.
 * Without it, MetaMask/injected/Coinbase wallet connections still work
 * (they don't go through WalletConnect's relay); only the WalletConnect
 * QR-code option itself will fail to initialize.
 */
const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "";

/** Falls back to the chain's public default RPC when unset - set your own
 *  paid endpoint (Ankr/QuickNode/NodeReal) for production traffic. */
const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL;

export const wagmiConfig = getDefaultConfig({
  appName: "Aave Arbitrage Executor",
  projectId: walletConnectProjectId || "00000000000000000000000000000000",
  chains: [bsc],
  transports: {
    [bsc.id]: http(rpcUrl),
  },
  ssr: true,
});
