import { Contract, type JsonRpcProvider } from "ethers";

export interface TokenInfo {
  symbol: string;
  address: string;
  decimals: number;
}

export interface RouterInfo {
  name: string;
  address: string;
  routerType: 0 | 1 | 3;
  /** V3 only: the separate QuoterV2 contract address (PancakeSwap V3 splits router/quoter). */
  quoterAddress?: string;
  /** V3 only: fee tiers to try, e.g. PancakeSwap V3 uses [100, 500, 2500, 10000]. */
  feeTiers?: number[];
}

export interface HopCandidate {
  router: string;
  quoter: string;
  routerType: 0 | 1 | 2 | 3;
  tokenIn: string;
  tokenOut: string;
  v3Fee: number;
  stableI: number;
  stableJ: number;
  quotedOut: bigint;
  routerName: string;
}

export interface RouteCandidate {
  name: string;
  baseAsset: TokenInfo;
  hops: HopCandidate[];
  /** Gross output of the full cycle, already net of every hop's pool swap fee. */
  grossOut: bigint;
}

const V2_ROUTER_ABI = ["function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)"];
const V3_QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
];
const WOMBAT_POOL_ABI = [
  "function quotePotentialSwap(address fromToken, address toToken, int256 fromAmount) view returns (uint256 potentialOutcome, uint256 haircut)",
];
const ZERO_QUOTER = "0x0000000000000000000000000000000000dEaD";

async function quoteV2(provider: JsonRpcProvider, r: RouterInfo, tokenIn: TokenInfo, tokenOut: TokenInfo, amountIn: bigint): Promise<HopCandidate | null> {
  try {
    const c = new Contract(r.address, V2_ROUTER_ABI, provider);
    const amounts: bigint[] = await c.getAmountsOut(amountIn, [tokenIn.address, tokenOut.address]);
    const out = amounts[amounts.length - 1];
    if (out === 0n) return null;
    return {
      router: r.address,
      quoter: ZERO_QUOTER,
      routerType: 0,
      tokenIn: tokenIn.address,
      tokenOut: tokenOut.address,
      v3Fee: 0,
      stableI: 0,
      stableJ: 0,
      quotedOut: out,
      routerName: r.name,
    };
  } catch {
    return null; // no pool for this pair on this router
  }
}

/** Tries every configured fee tier and keeps whichever pool quotes best - PancakeSwap V3
 *  doesn't guarantee every tier has a deployed/liquid pool for a given pair. */
async function quoteV3(provider: JsonRpcProvider, r: RouterInfo, tokenIn: TokenInfo, tokenOut: TokenInfo, amountIn: bigint): Promise<HopCandidate | null> {
  if (!r.quoterAddress || !r.feeTiers?.length) return null;
  const quoterContract = new Contract(r.quoterAddress, V3_QUOTER_ABI, provider);

  let best: HopCandidate | null = null;
  await Promise.all(
    r.feeTiers.map(async (fee) => {
      try {
        const result = await quoterContract.quoteExactInputSingle.staticCall({
          tokenIn: tokenIn.address,
          tokenOut: tokenOut.address,
          amountIn,
          fee,
          sqrtPriceLimitX96: 0n,
        });
        const out: bigint = result[0];
        if (out > 0n && (!best || out > best.quotedOut)) {
          best = {
            router: r.address,
            quoter: r.quoterAddress!,
            routerType: 1,
            tokenIn: tokenIn.address,
            tokenOut: tokenOut.address,
            v3Fee: fee,
            stableI: 0,
            stableJ: 0,
            quotedOut: out,
            routerName: `${r.name}(fee=${fee})`,
          };
        }
      } catch {
        // no pool at this fee tier - skip
      }
    })
  );
  return best;
}

async function quoteWombat(provider: JsonRpcProvider, r: RouterInfo, tokenIn: TokenInfo, tokenOut: TokenInfo, amountIn: bigint): Promise<HopCandidate | null> {
  try {
    const c = new Contract(r.address, WOMBAT_POOL_ABI, provider);
    const [potentialOutcome]: [bigint, bigint] = await c.quotePotentialSwap(tokenIn.address, tokenOut.address, amountIn);
    if (potentialOutcome === 0n) return null;
    return {
      router: r.address,
      quoter: ZERO_QUOTER,
      routerType: 3,
      tokenIn: tokenIn.address,
      tokenOut: tokenOut.address,
      v3Fee: 0,
      stableI: 0,
      stableJ: 0,
      quotedOut: potentialOutcome,
      routerName: r.name,
    };
  } catch {
    return null; // tokenIn/tokenOut not both in this pool
  }
}

/**
 * Multi-DEX scanning (requirement #3): queries every whitelisted router for a
 * single tokenIn->tokenOut hop - across V2-style (PancakeSwap V2, Biswap,
 * ApeSwap, BakerySwap), V3-style (PancakeSwap V3, tried across every
 * configured fee tier), and Wombat-style asset-liability pools - and returns
 * whichever quotes the best output. This is what makes route generation
 * genuinely multi-DEX instead of hardcoded to one router: each hop of every
 * candidate route independently picks its own best-priced venue and pool
 * type.
 *
 * Curve/Ellipsis-style pools (routerType 2) are deliberately NOT auto-scanned
 * here: unlike the other three types, a Curve-style pool needs per-pool token
 * *indices* (stableI/stableJ), which aren't derivable from token addresses
 * alone - they're pool-specific metadata. Curve-style hops remain fully
 * usable via hand-authored routes in strategies.json (static mode).
 */
export async function findBestHop(
  provider: JsonRpcProvider,
  routers: RouterInfo[],
  tokenIn: TokenInfo,
  tokenOut: TokenInfo,
  amountIn: bigint,
  cache: Map<string, HopCandidate | null>
): Promise<HopCandidate | null> {
  const cacheKey = `${tokenIn.address.toLowerCase()}|${tokenOut.address.toLowerCase()}|${amountIn.toString()}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey)!;

  const results = await Promise.all(
    routers.map((r) => {
      if (r.routerType === 0) return quoteV2(provider, r, tokenIn, tokenOut, amountIn);
      if (r.routerType === 1) return quoteV3(provider, r, tokenIn, tokenOut, amountIn);
      return quoteWombat(provider, r, tokenIn, tokenOut, amountIn);
    })
  );

  let best: HopCandidate | null = null;
  for (const candidate of results) {
    if (candidate && (!best || candidate.quotedOut > best.quotedOut)) {
      best = candidate;
    }
  }

  cache.set(cacheKey, best);
  return best;
}

/**
 * Multi-hop, multi-asset route search (requirements #4 + #5): enumerates
 * every 2-hop (base -> X -> base) and 3-hop / triangular (base -> X -> Y ->
 * base) cycle across all configured base assets and intermediate tokens,
 * using findBestHop() for each leg so each hop can land on a different DEX.
 *
 * A shared `cache` across the whole call means a (tokenIn, tokenOut,
 * amountIn) hop already resolved for one candidate route is never re-quoted
 * for another - keeps RPC call volume proportional to the number of distinct
 * hops actually encountered, not the (larger) number of candidate routes.
 */
export async function generateCandidateRoutes(
  provider: JsonRpcProvider,
  baseAssets: TokenInfo[],
  intermediateTokens: TokenInfo[],
  routers: RouterInfo[],
  probeAmountByAssetAddress: Record<string, bigint>
): Promise<RouteCandidate[]> {
  const candidates: RouteCandidate[] = [];
  const cache = new Map<string, HopCandidate | null>();

  for (const base of baseAssets) {
    const probe = probeAmountByAssetAddress[base.address.toLowerCase()];
    if (!probe) continue;
    const others = intermediateTokens.filter((t) => t.address.toLowerCase() !== base.address.toLowerCase());

    for (const x of others) {
      const hop1 = await findBestHop(provider, routers, base, x, probe, cache);
      if (!hop1) continue;

      // 2-hop: base -> x -> base
      const hop2Back = await findBestHop(provider, routers, x, base, hop1.quotedOut, cache);
      if (hop2Back) {
        candidates.push({
          name: `${base.symbol}->${x.symbol}->${base.symbol} (${hop1.routerName}/${hop2Back.routerName})`,
          baseAsset: base,
          hops: [hop1, hop2Back],
          grossOut: hop2Back.quotedOut,
        });
      }

      // 3-hop / triangular: base -> x -> y -> base
      for (const y of others) {
        if (y.address.toLowerCase() === x.address.toLowerCase()) continue;
        const hop2 = await findBestHop(provider, routers, x, y, hop1.quotedOut, cache);
        if (!hop2) continue;
        const hop3 = await findBestHop(provider, routers, y, base, hop2.quotedOut, cache);
        if (!hop3) continue;

        candidates.push({
          name: `${base.symbol}->${x.symbol}->${y.symbol}->${base.symbol} (${hop1.routerName}/${hop2.routerName}/${hop3.routerName})`,
          baseAsset: base,
          hops: [hop1, hop2, hop3],
          grossOut: hop3.quotedOut,
        });
      }
    }
  }

  return candidates;
}
