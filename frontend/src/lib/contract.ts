import { bsc } from "wagmi/chains";

/**
 * Deployed AaveArbitrageExecutorV3 on BNB Smart Chain mainnet. Override via
 * NEXT_PUBLIC_CONTRACT_ADDRESS for a different deployment (e.g. testnet
 * demo) without a code change.
 */
export const CONTRACT_ADDRESS = (process.env.NEXT_PUBLIC_CONTRACT_ADDRESS ??
  "0x145Fb0A33C157942a043D034b8D8b992d939F24f") as `0x${string}`;

export const CHAIN = bsc;

export const KEEPER_API_URL = process.env.NEXT_PUBLIC_KEEPER_API_URL ?? "";

export const BSCSCAN_TX_URL = (hash: string) => `https://bscscan.com/tx/${hash}`;
export const BSCSCAN_ADDRESS_URL = (addr: string) => `https://bscscan.com/address/${addr}`;

/** Well-known BSC mainnet asset addresses used across the dashboard/admin UI
 *  for labeling raw addresses returned by the contract. Sourced from the
 *  keeper's verified addresses.bsc.json - kept in sync manually since the
 *  frontend has no build-time access to the keeper's config files. */
export const KNOWN_ASSETS: Record<string, { symbol: string; decimals: number }> = {
  "0x55d398326f99059fF775485246999027B3197955": { symbol: "USDT", decimals: 18 },
  "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d": { symbol: "USDC", decimals: 18 },
  "0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409": { symbol: "FDUSD", decimals: 18 },
  "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c": { symbol: "WBNB", decimals: 18 },
  "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c": { symbol: "BTCB", decimals: 18 },
  "0x2170Ed0880ac9A755fd29B2688956BD959F933F8": { symbol: "ETH", decimals: 18 },
};

export function labelAsset(address: string): string {
  const known = KNOWN_ASSETS[address];
  return known ? known.symbol : `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/** Verified BSC mainnet DEX router addresses, sourced from the keeper's own
 *  cross-checked addresses.bsc.json / routes.config.example.json. */
export const KNOWN_ROUTERS: Record<string, string> = {
  "0x10ED43C718714eb63d5aA57B78B54704E256024E": "PancakeSwap V2",
  "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4": "PancakeSwap V3",
  "0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8": "Biswap",
  "0xcF0feBd3f17CEf5b47b0cD257aCf6025c5BFf3b7": "ApeSwap",
  "0xCDe540d7eAFE93aC5fE6233Bee57E1270D3E330F": "BakerySwap",
  "0x312Bc7eAAF93f1C60Dc5AfC115FcCDE161055fb0": "Wombat Exchange",
};

export function labelRouter(address: string): string {
  return KNOWN_ROUTERS[address] ?? `${address.slice(0, 6)}...${address.slice(-4)}`;
}
