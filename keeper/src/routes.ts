import { Contract, type JsonRpcProvider } from "ethers";

export interface TokenInfo {
  symbol: string;
  address: string;
  decimals: number;
}

export interface RouterInfo {
  name: string;
  address: string;
  routerType: 0 | 1 | 2;
}

export interface HopCandidate {
  router: string;
  quoter: string;
  routerType: 0 | 1 | 2;
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
const ZERO_QUOTER = "0x0000000000000000000000000000000000dEaD";

/**
 * Multi-DEX scanning (requirement #3): queries every whitelisted V2-style
 * router for a single tokenIn->tokenOut hop and returns whichever one quotes
 * the best output. This is what makes route generation "multi-DEX" instead
 * of hardcoded to one router - each hop of every candidate route
 * independently picks its own best-priced venue.
 *
 * Only V2-style routers are compared here (uniform getAmountsOut interface
 * makes batching trivial and cheap). V3/stable routers can still be used by
 * hand-authored routes in strategies.json; extending the auto-scanner to
 * quote those too is a straightforward follow-up (V3 quoters are non-view
 * and more expensive to batch, so it's a deliberate v1 scope cut, not an
 * oversight).
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

  let best: HopCandidate | null = null;
  const path = [tokenIn.address, tokenOut.address];

  await Promise.all(
    routers
      .filter((r) => r.routerType === 0)
      .map(async (r) => {
        try {
          const c = new Contract(r.address, V2_ROUTER_ABI, provider);
          const amounts: bigint[] = await c.getAmountsOut(amountIn, path);
          const out = amounts[amounts.length - 1];
          if (out > 0n && (!best || out > best.quotedOut)) {
            best = {
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
          }
        } catch {
          // No pool for this pair on this router - not an error, just skip it.
        }
      })
  );

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
