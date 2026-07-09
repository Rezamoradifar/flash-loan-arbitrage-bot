# Real-world BNB Chain arbitrage upgrade

This documents a focused upgrade pass over the whole project: on-chain contract, mocks, tests, and
the off-chain keeper bot. Every change below is explained with *why*, not just *what*.

## 1. Why the arbitrage path was returning a negative spread

This was the central question, and it has a real, structural answer — not a bug in the quoting math.

The example route shipped earlier (`USDT -> WBNB -> USDC -> USDT`) used **the same DEX
(PancakeSwap V2) for all three hops**. A single DEX's own pools are priced *consistently with each
other* by construction: PancakeSwap's own USDT/WBNB, WBNB/USDC, and USDC/USDT pools all derive
their relative prices from the same market activity and the same arbitrageurs constantly
re-balancing them against each other. If routing through all three, in a cycle, on the *same* DEX,
implied a free profit, PancakeSwap's own liquidity providers and bots would already have closed
that gap — usually within the same block it appears. So a same-DEX triangular cycle returning a
negative (or barely-positive, sub-fee) spread most of the time is *expected market behavior*, not
a code defect. `test/ForkBsc.t.sol`'s `test_SameDexVsCrossDexSpread_Informational` demonstrates this
directly: it prices the identical cycle two ways — entirely on PancakeSwap, and with the last hop
routed through Biswap instead — and logs both spreads side by side against real chain state.

Real, exploitable spreads come from price *differences between separate venues* (different DEXs
pricing the same pair slightly differently) or from momentary imbalance right after a large trade
on one specific pool. That's exactly what requirement #3 (multi-DEX scanning) targets, and it's the
main structural change in this upgrade.

## 2. Contract changes (`src/AaveArbitrageExecutorV3.sol`)

### Per-asset minimum profit threshold (real bug fix)

`minProfitThreshold` was a single global `uint256` compared directly against `grossProfit`
regardless of which asset was borrowed. That's fine for a single-asset deployment, but silently
wrong once you support **multiple base assets with very different value-per-unit** (requirement
#4): a threshold of `10e18` is a sensible "$10 minimum" for 18-decimal USDT, but the exact same raw
value is a ~$5,500+ minimum for 18-decimal WBNB, and an absurdly tiny fraction of a cent for
18-decimal BTCB (~$64k/BTC). Added `minProfitThresholdPerAsset` (mapping) +
`setMinProfitThresholdForAsset()`, with `0` falling back to the existing global value — same
pattern already used by `maxFlashLoanPerAsset`. `_settleAndDistribute` now resolves the effective
threshold per-asset before comparing. Covered by
`test_RevertWhen_ProfitBelowPerAssetThreshold` and `test_PerAssetThresholdOverridesGlobal_AllowsLowerBar`.

### Gas-cost-aware profit helper (requirement #6, the missing cost)

The contract already accounted for the flash-loan premium (`estimateFlashLoanFee`) and swap fees
(baked into every hop's own DEX quote — `getAmountsOut`/`quoteExactInputSingle`/`get_dy` all return
amounts *net* of pool fees already). Gas was the one cost missing an on-chain accounting path. Added:

- `estimateGasCostInAsset(asset, wrappedNative, gasUnits, gasPriceWei)` — converts a gas cost from
  native wei into `asset`'s smallest units using the Chainlink USD feeds already wired up via
  `setPriceFeed()` (reusing the same feed mechanism the oracle-sanity check uses). Returns `0` if
  either feed isn't configured — a deliberate "unknown, don't trust this as free" signal rather than
  silently treating gas as costless.
- `expectedNetProfitAfterGas(...)` — `expectedNetProfit()` minus the above, returned as a **signed**
  `int256` so a genuinely gas-unprofitable trade is directly visible as a negative number.

`expectedNetProfit` was changed from `external` to `public` so the new function can call it directly
instead of paying for an extra external call. Both new functions are covered by
`test_ExpectedNetProfitAfterGas_AccountsForRealGasCost` (using mock Chainlink feeds to prove the
math is right, including a case designed to go negative) and
`test_EstimateGasCostInAsset_ReturnsZeroWithoutFeeds`.

**Design decision, explained:** the contract does *not* refuse execution on-chain if the post-gas
profit is negative. Gas cost is a property of the *caller's* transaction (final gas price, and to
a lesser extent gas used, aren't fully known until the transaction is mined), so enforcing it
on-chain would mean either trusting a caller-supplied gas price (spoofable) or reading `tx.gasprice`
mid-execution (already available via `estimateGasCost()`, but doesn't help decide *before* borrowing
without also trusting a price feed pairing that the owner may not have configured for every asset).
The pattern used by essentially every real MEV/arbitrage bot — and the one used here — is: **off-chain
keeper filters on full-cost profitability before ever sending a transaction; on-chain contract
enforces asset-denominated spread/profit thresholds as a backstop that doesn't depend on gas price
guesses.** This is documented, not a gap.

### Gas optimizations

- Cached `steps.length` / `routers.length` / etc. into a local variable before each loop instead of
  re-reading it every iteration (`_validateSteps`, `_runSwapCycle`, `_quoteCycle`, `quoteBestOfV2`,
  `supportedRouters`, `supportedAssets`).
- Loop counters now use `unchecked { ++i; }` — safe because the swap-cycle loops are hard-capped at
  `MAX_STEPS` (3) and the array-input loops are bounded by the block gas limit long before a
  `uint256` counter could ever overflow.
- `quoteBestOfV2`'s inner loop no longer uses `continue` inside a `try/catch` (replaced with a plain
  `if`), which is marginally cheaper and reads more directly.

These are intentionally conservative: no change to the double-approve-then-reset-to-zero pattern in
`_swapV2`/`_swapV3`/`_swapStable`, even though skipping the reset would save ~5,000 gas per hop —
that reset is a deliberate defense-in-depth measure (a leftover non-zero allowance can never be
reused if this contract is later pointed at a bad path) and trading it away for gas savings is a
security-relevant decision that belongs to the owner, not a default I'll make silently.

### Fixed during this work: same-block-guard genesis bug

Found while writing the local deployment demo, not part of this specific upgrade pass but worth
restating here: `oncePerBlock`'s default "last op block" was `0`, which collides with
`block.number == 0` on a freshly-started chain (Anvil/Hardhat before the first block is mined) and
made the very first-ever call revert. Fixed by initializing it to `type(uint256).max` in the
constructor.

## 3. Off-chain keeper changes (`keeper/`)

### Multi-DEX route generator (`keeper/src/routes.ts`) — requirements #3, #4, #5

`findBestHop()` queries every whitelisted V2-style router for a single hop and keeps whichever
quotes the best output — this is what makes route generation genuinely multi-DEX instead of
hardcoded to one router: **each hop of every candidate route independently picks its own
best-priced venue**, exactly mirroring how real cross-DEX arbitrage searchers work.

`generateCandidateRoutes()` enumerates every 2-hop (`base -> X -> base`) and 3-hop / triangular
(`base -> X -> Y -> base`) cycle across all configured base assets and intermediate tokens, calling
`findBestHop()` for each leg. A shared cache (keyed by `tokenIn|tokenOut|amountIn`) means a hop
already resolved for one candidate is never re-quoted for another candidate that happens to share
it — keeps RPC call volume proportional to the number of *distinct hops actually encountered*, not
the larger number of candidate routes.

**Scope cut, stated plainly:** only V2-style routers are compared in the auto-scanner (uniform
`getAmountsOut` interface makes batching trivial and cheap). V3-style and stable-swap routers can
still be used via hand-authored `strategies.json` routes (static mode, unchanged), and extending the
auto-scanner to quote those too is a reasonable follow-up — V3 quoters are non-view and more
expensive to batch per-candidate, so leaving them out of the *automatic* scan for now was a
deliberate v1 boundary, not an oversight.

**Also stated plainly:** route assembly picks the best router *per hop independently* (greedy), not
the jointly-optimal router combination across all hops of a cycle (which would require the full
`N^numHops` combinatorics this design specifically avoids for RPC-cost reasons). For 3 real V2-style
routers this is a small, deliberate approximation — greedy-per-hop is very likely to *also* be the
joint optimum in practice, since each hop's quote is independent of the others' router choice, but
that isn't a mathematical guarantee.

### Full cost accounting before submission (`keeper/src/index.ts`) — requirement #6, #7

`evaluateCandidate()` now applies, in order: (1) the route's gross output, already net of swap fees
from each hop's own quote; (2) an off-chain slippage buffer haircut (`slippageBufferBps`, distinct
from the on-chain `executeArbitrage` slippage tolerance — this one protects the *pre-trade
decision* against the quote moving before the tx lands); (3) the flash-loan premium; (4) gas cost,
converted to the borrowed asset via the new on-chain `estimateGasCostInAsset()` helper (with a
clearly logged warning, not a silent zero, when price feeds aren't configured); then compares the
result against the **per-asset** minimum profit threshold from `routes.config.json` before ever
calling `executeArbitrage`. A trade with negative or insufficient net profit is never submitted —
requirement #7, enforced off-chain *and* redundantly on-chain via the contract's own
`minSpreadBPS`/`minProfitThreshold(PerAsset)` checks, which still run inside `executeArbitrage`
regardless of what the keeper computed.

### Configurable thresholds (requirement #8)

`routes.config.json`'s `minProfitByAssetAddress` gives every base asset its own minimum profit,
matching the new on-chain per-asset threshold. `slippageBufferBps` (pre-trade filter) and
`executionSlippageBps` (on-chain execution tolerance) are separately configurable, along with
`gasUnitsPerTrade` and per-asset probe amounts.

### Two scan modes, not a breaking rewrite

`SCAN_MODE=dynamic` (default) runs the new multi-DEX/multi-asset/multi-hop scanner.
`SCAN_MODE=static` keeps the original fixed-route `strategies.json` behavior, unchanged, for anyone
who wants the bot restricted to one specific, manually-reviewed route instead of full auto-scan.

## 4. Test changes

- `test/AaveArbitrageExecutor.t.sol`: 4 new deterministic unit tests (mock-based, no live network
  needed) covering the per-asset threshold fix and the gas-cost-aware profit helper, including a
  case engineered to actually go negative — proving the math, not just the happy path. 12/12 pass.
- `test/ForkBsc.t.sol`, expanded against real BNB Chain state:
  - `test_BnbUsdChainlinkFeedIsLive` — sanity-checks the real Chainlink BNB/USD feed.
  - `test_MultiAssetLiquiditySanityCheck` — checks direct PancakeSwap V2 liquidity for all 6
    requirement-#4 base assets (USDT, USDC, FDUSD, WBNB, BTCB, ETH) against WBNB.
  - `test_SameDexVsCrossDexSpread_Informational` — the direct answer to "why negative spread" (see
    §1), logging same-DEX vs cross-DEX pricing for the identical cycle.
  - `test_AttemptRealFlashLoanArbitrage` / `test_AttemptRealFlashLoanArbitrage_WbnbCrossDex` —
    attempts a real flash loan against real Aave + real DEXs for two different base assets,
    accepting either a real profitable execution or a correct `SpreadTooLow` revert and reporting
    which happened. All routers/assets get whitelisted in `setUp()`.

Run the deterministic suite anywhere: `forge test`. Run the fork suite against real chain state
(needs your own RPC — this sandbox can't reach one): `forge test --fork-url <BSC RPC> --match-contract ForkBscTest -vvvv`.

## 5. What genuinely was NOT done, and why

- **No profit fabrication or bypass of economic checks**, per the explicit requirement. Every new
  code path either *adds* a cost the bot subtracts before deciding to trade, or *tightens* what
  counts as profitable (per-asset thresholds). Nothing here makes a trade look more profitable than
  it is.
- **On-chain gas-cost enforcement, not just off-chain filtering** — deliberately not done; see the
  design-decision note in §2. The off-chain keeper is the right place for gas-price-dependent
  filtering; the contract stays the safety backstop.
- **V3/stable-pool auto-scanning** — deliberately out of scope for this pass (see §3); still fully
  usable via `strategies.json` static routes.
- **Globally-optimal joint router selection across all hops of a cycle** — deliberately approximated
  with greedy per-hop best-quote selection, for RPC-cost reasons (see §3).

---

# Round 2: production-grade scanner — more DEXs, 200+ pairs, continuous scanning, detailed logs

## 6. DEX coverage: what's genuinely in, and what's honestly left out

| DEX | Status | Why |
|---|---|---|
| PancakeSwap V2 | ✅ in (V2-style, `routerType=0`) | Already had it |
| PancakeSwap V3 | ✅ in (`routerType=1`), now also auto-scanned across fee tiers `[100, 500, 2500, 10000]` | Genuine Uniswap-V3-compatible interface; previously wired on-chain but not compared by the off-chain scanner — now it is |
| Biswap | ✅ in (V2-style) | Already had it |
| ApeSwap | ✅ in (V2-style) | Already had it |
| BakerySwap | ✅ **new** (V2-style) | Router address confirmed directly labeled "BakerySwap: BakerySwap Router" on BscScan |
| Wombat Exchange | ✅ **new** — genuine 4th router type (`routerType=3`) | Interface (`swap`/`quotePotentialSwap`) pulled straight from `wombat-exchange/v1-core`'s own GitHub source, not guessed — Wombat addresses tokens directly (no per-pool index like Curve), confirmed by reading `contracts/wombat-core/interfaces/IPool.sol` |
| THENA | ❌ **deliberately excluded** | Two independent problems: (1) THENA's V3 AMM uses **Algebra Integral**, not vanilla Uniswap V3 — Algebra has dynamic per-swap fees and a different quoter interface, so it is **not** compatible with the `IQuoterV2`/`IRouterV3` interfaces already implemented, and claiming support without actually implementing an Algebra adapter would be exactly the kind of "fabricated" support the requirements explicitly forbid. (2) THENA's legacy V2-style router address could not be cross-verified with the same confidence as every other address in this repo (only a generic, unlabeled "Router" hit, not a clearly-labeled "THENA: Router" BscScan entry backed by a second independent source) — so it's left out rather than shipped as a guess. |

Every new address (BakerySwap router, Wombat Main Pool, Wombat's `IPool` interface) is documented
with its source in `keeper/addresses.bsc.json` / this file. One is worth calling out directly: while
transcribing the Wombat Main Pool address, Solidity's own EIP-55 checksum validation caught a
capitalization typo in one hex character during `forge build` — a real, concrete demonstration of
why every address in this repo goes through a compiler/tool check, not just a visual copy-paste.

## 7. 200+ high-liquidity token pairs — real tokens, not fabricated

Pulled `src/tokens/pancakeswap-default.json` (13 tokens — PancakeSwap's own strictest, most-vetted
list) and `src/tokens/pancakeswap-extended.json` (428 tokens) directly from
**`github.com/pancakeswap/token-list`** — PancakeSwap's own official token-list repository — and
selected 58 well-known, established symbols from that combined set (stablecoins, wrapped majors,
long-standing DeFi/CEX tokens). Every address in `keeper/tokenlist.bsc.json` is real and sourced;
none were guessed.

58 tokens is not itself "200 pairs" — it's the *input* to the same token-graph × router-registry
approach already in `routes.ts`, which turns it into `58 × 57 = 3,306` possible ordered token pairs,
multiplied further by 3-hop triangular combinations and by however many of the 6 routers can quote
each pair. That comfortably clears "at least 200 high-liquidity token pairs" — the honest caveat is
in §9 below (RPC cost of scanning at that scale continuously).

**On "high-liquidity" specifically:** PancakeSwap's own token lists encode *curation* (real, established,
non-scam tokens), not *live TVL ranking* — there's no public, reliably-fetchable "top BSC pairs by
liquidity right now" feed this sandbox could pull from without risking stale/fabricated data. Treat
the 58-token list as a high-quality *candidate* set, and verify actual pool depth for any specific
pair you're relying on (e.g. via the DEX's own UI, or `getReserves()`) before sizing a real trade
around it — being a real, listed token doesn't guarantee deep liquidity for every pair with every
other token in the list.

## 8. Continuous evaluation

Added `TRIGGER_MODE=block` (`keeper/src/index.ts`, `runWithTrigger()`): subscribes to new blocks via
`provider.on("block", ...)` and re-scans on every one, instead of a fixed timer. This works
transparently over both a WebSocket `RPC_URL` (a true push subscription) and a plain HTTP `RPC_URL`
(ethers emulates the same `"block"` event by polling `eth_blockNumber` internally) — no branching
needed in the bot's own code either way. A `running` guard skips a scan if the previous one hasn't
finished yet, so overlapping block arrivals never queue up concurrent scans against the same RPC.
`TRIGGER_MODE=poll` (the default) keeps the original fixed-interval behavior, which is still the
safer choice against a rate-limited public RPC where you want the scan cadence fully under your own
control rather than reactive to block time.

## 9. Detailed accept/reject logging

Every candidate route now produces a structured `DecisionBreakdown` (`keeper/src/index.ts`,
`logDecision()`) showing, for both accepted **and rejected** candidates: gross cycle output, output
after the slippage buffer, the flash-loan premium, output after premium, the gas cost estimate (and
whether it's a real on-chain-computed number or an unknown treated as 0), the final net profit, the
per-asset minimum threshold, and a plain-English reason for the decision. `VERBOSE_LOGS=true` prints
a readable multi-line breakdown per candidate; the default is one structured line per candidate so
scanning 200+ pairs doesn't flood the terminal. `LOG_REJECTED=false` silences rejection lines once
you've reviewed why routes are being turned down and just want to watch for real opportunities.

## 10. Honest scale caveat

Scanning the full 58-token intermediate list × 6 routers × up to 3 hops, every poll/block, is a
real volume of `eth_call`s — potentially thousands per scan once 3-hop triangular combinations are
included (bounded by the per-hop result cache described in §3, but still substantial). Against a
free/shared public RPC this can be slow or hit rate limits. For continuous (`TRIGGER_MODE=block`)
operation at this scale, use an RPC provider that can actually sustain the call volume (a paid tier,
or your own node) — or trim `intermediateTokens` down to a smaller, higher-conviction subset for
tighter poll loops. This is a real operational trade-off, not something the code can wish away.

---

# Round 3: architecture split, security hardening, observability, illiquidity filter

## 11. Contract: Ownable2Step + DRY

- Swapped `Ownable` for OpenZeppelin's `Ownable2Step`: ownership transfer now requires the new
  owner to actively call `acceptOwnership()` before anything changes. A typo'd or unreachable
  address passed to `transferOwnership()` can no longer permanently brick the contract's owner —
  the old owner stays in control until the new one confirms. Covered by
  `test_Ownable2Step_RequiresAcceptanceToCompleteTransfer`.
- Extracted `_minOutFromQuote()` (the zero-check + slippage-tolerance math repeated identically in
  all four `_swapX` functions) and `_resetApproval()` (the trailing `forceApprove(spender, 0)` also
  repeated four times) into shared internal helpers. No behavior change — same checks, same calls,
  just not copy-pasted four times.

## 12. Illiquid-pool filter (`routes.ts`)

Added a price-impact check for V2-style hops: each candidate is also quoted at 1% of the real trade
size, and rejected if the full-size trade's effective rate is worse than the small-size rate by more
than `maxPriceImpactBps` (configurable in `routes.config.json`, default 500 = 5%). A deep pool prices
both sizes almost identically; a thin pool shows heavy degradation at the full size. This needs no
factory/pair address discovery — one extra `getAmountsOut` call per V2 hop — and is the concrete
answer to "evaluate many liquid token pairs and ignore illiquid pools." Disabled by default
(`maxPriceImpactBps: 0`) to skip the extra RPC call for anyone who doesn't need it.

## 13. Scanner / keeper architecture split

The single `index.ts` from rounds 1-2 is now three modules with one job each (see `ARCHITECTURE.md`
for the full picture):

- **`scanner.ts`** — generates candidates, costs them (premium + fees + gas + slippage buffer),
  logs every accept/reject decision with its full breakdown, and returns **all** evaluated
  candidates **ranked by net profit descending** (`Opportunity[]`) — "a ranked list of
  opportunities," not just a pass/fail per candidate.
- **`keeper.ts`** — owns the trigger loop (poll or per-block) and static-vs-dynamic dispatch, takes
  the scanner's ranked list, and submits only the single best `executable` opportunity (the
  contract's own same-block replay guard means only one execution can land per block anyway, so
  submitting more than the top one has no benefit).
- **`metrics.ts`** — a dependency-free counter (evaluated / accepted / rejected-by-reason-category /
  cumulative accepted net profit per asset), logged as a one-line summary every scan cycle.
- **`index.ts`** — now just wires up the provider/wallet/contract, checks the configured key is
  actually authorized on-chain, and hands off to `keeper.ts`. Down from owning the whole loop to
  ~35 lines.

## 14. A real bug the refactor's smoke test caught

Every module change above was verified twice: `tsc --noEmit` (types) and an actual run against a
live local Anvil chain with a real deployed contract (not just a mental read-through). The live run
caught a genuine bug that pure type-checking couldn't: the placeholder address used everywhere for
an "unused quoter" field (`0x000...dEaD`, the common burn-address spelling) fails ethers.js's EIP-55
checksum validation. Ethers responds to a checksum-invalid hex string by treating it as a possible
ENS name and trying to resolve it — which throws `network does not support ENS` on any chain without
ENS support, including plain local Anvil chains **and real BSC mainnet itself**. This would have
silently broken every quote call in production. Fixed by switching the placeholder to the properly
zero-padded `address(0)` (which is checksum-invariant and also matches the convention the Solidity
contract's own tests already use for "unused" fields) in `routes.ts` and `strategies.example.json`.
This is exactly the kind of bug that only surfaces by actually executing the code path, not by
reading it — worth internalizing as a reason the local-Anvil smoke test loop exists at all.

## 15. Frontend debugging pass: two real hang/silent-failure bugs found via live testing

A user report ("most dashboard pages never finish loading, contract data is not displayed") led to
a full audit of every data-fetching hook in `frontend/`. As with §14, this was verified against a
real local Anvil deployment (not just code review), which is what surfaced the second bug below -
neither `tsc` nor `next build` catches either of these.

**Bug 1 - infinite loading, `useContractEvents.ts` / `useAnalyticsHistory.ts`.** Both hooks gated
their entire fetch effect on a *separate* `useBlockNumber()` hook's `data`:
`if (!publicClient || !currentBlock || fetchedRef.current) return;`. If that separate query's RPC
call fails (bad endpoint, rate limit, CORS), TanStack Query exhausts its retries and settles into a
permanent error state - `data` stays `undefined` forever, and without `watch: true` it never
automatically retries again. The gated effect above then never runs, so `loading` (initialized
`true`) never becomes `false` - the exact "Analytics stays loading" / "stuck forever" symptom
reported, with no error ever surfaced. Fixed by removing the cross-hook dependency entirely: each
hook now calls `publicClient.getBlockNumber()` itself, inline, inside the same `try/catch` as
everything else, wrapped in an explicit timeout (`src/lib/rpcUtils.ts`'s `withTimeout`) and with
concurrency-limited (`mapWithConcurrency`) chunked RPC calls instead of unbounded `Promise.all`
bursts that free-tier RPC providers commonly rate-limit.

**Bug 2 - silently missing contract data, wagmi's default multicall batching.** Even after fixing
the hang, a live test showed `owner`/`keeper`/`profitRecipient` reads (`ContractInfoCard`,
`CurrentConfigCard`) resolving to `undefined` - not loading, not erroring, just permanently blank -
while raw `publicClient` calls (block number, gas price, event logs) worked fine. Tracing the actual
RPC traffic showed wagmi's default behavior (`batch.multicall: true`) silently aggregating every
`useReadContract`/`useReadContracts` call in the same render tick into one `eth_call` to the
Multicall3 contract (`0xcA11bde05977b3631167028862bE2a173976CA11`). A fresh/non-forked local Anvil
chain doesn't have Multicall3 deployed there, so that call returns an empty `"0x"` result - which
viem/wagmi treats as "no data" for every batched read at once, with zero error surfaced anywhere.
Real BSC mainnet does have Multicall3 at the canonical address, so this exact failure mode is less
likely there, but the same silent-blank behavior can plausibly occur against any RPC endpoint that
doesn't proxy calls to that one contract correctly (some private/custom nodes, certain rate-limited
proxies). Fixed by setting `batch: { multicall: false }` in `wagmiConfig.ts` - every read becomes an
independent `eth_call`, trading a few extra parallel requests per page for "every read failure mode
is a real, visible error" instead of "some reads just silently don't show up."

**Supporting hardening**, same pass:
- `wagmiConfig.ts`: default RPC fallback switched from viem's baked-in `bsc-dataseed.binance.org`
  (known CORS/reliability issues for direct browser requests) to PublicNode's `bsc-rpc.publicnode.com`
  when `NEXT_PUBLIC_RPC_URL` is unset; explicit `http()` `timeout`/`retryCount`/`retryDelay`; fixed a
  malformed (34-char, not 32-hex) placeholder WalletConnect project ID.
- `providers.tsx`: global `QueryClient` now sets bounded `retry`/`retryDelay` instead of relying on
  library defaults, so a failing read surfaces an error in seconds, not tens of seconds.
- `useKeeperApi.ts`: `fetch()` calls to the keeper's API wrapped in an `AbortController` timeout -
  native `fetch` has no default timeout, so an unreachable keeper host could otherwise hang that
  query indefinitely too.
- New `useRpcHealth` hook + `RpcHealthBanner` component: one direct connectivity probe surfaced as a
  single honest banner ("can't reach your RPC") instead of a dozen silent per-card blanks when the
  configured endpoint is down.

**Verification method**: deployed the real `AaveArbitrageExecutorV3` (via `DeployLocalDemo.s.sol`,
which also executes one real arbitrage operation end-to-end) to a live local Anvil chain, pointed
the frontend at it, and confirmed via Playwright screenshots that Dashboard/Analytics/Transactions
all populate with real data (owner/keeper addresses, operation counts, event timeline, profit/gas/
router charts, transaction table) - then repeated against a deliberately unreachable RPC URL and
confirmed every page resolves to a clear error state (banner + in-page message) within ~3.5 seconds
instead of hanging.

## 16. Server-side RPC proxy - keeping a paid/keyed RPC URL out of the client bundle

The user planned to point `NEXT_PUBLIC_RPC_URL` at a metered RPC provider (Tatum) with an API key
embedded in the URL's query string. Any `NEXT_PUBLIC_*` env var is inlined into the client JavaScript
bundle at build time - it would have been visible to every site visitor via view-source or the
Network tab, exposing a paid key to the public internet.

Added `frontend/src/app/api/rpc/route.ts`, a same-origin Next.js Route Handler that proxies JSON-RPC
requests to a server-only `RPC_URL` env var (no `NEXT_PUBLIC_` prefix, read at request time, never
shipped to the browser). `wagmiConfig.ts`'s `rpcUrl` now defaults to `/api/rpc` instead of a direct
endpoint - the browser only ever talks to its own origin. This also incidentally makes CORS a
non-issue regardless of upstream provider, since only the Node server (not the browser) ever
contacts the real RPC host.

The proxy denylists write/introspection methods (`eth_sendRawTransaction`, `eth_sendTransaction`,
`eth_sign*`, `personal_*`/`debug_*`/`admin_*`/`wallet_*`/`miner_*`/`txpool_*`) - this dashboard's
public client only ever needs read methods (calls, logs, block/gas queries, filter polling for live
event watching); wallet-initiated transactions go through the connected wallet's own provider
directly, never through this route. Also applies a simple in-memory per-IP sliding-window rate limit
(120 req/min) so the now-public endpoint can't be used to freely burn a metered upstream key's quota.

Verified end-to-end against the same local Anvil deployment: confirmed via Playwright network
tracing that the browser contacts only its own origin (`127.0.0.1:3100`) for every request - the
real upstream RPC URL never appears anywhere in browser-visible traffic - while the dashboard still
resolves owner/keeper/event/analytics data correctly through the proxy.

`NEXT_PUBLIC_RPC_URL` still exists as an opt-in escape hatch (talk to an RPC directly from the
browser, bypassing the proxy) for deployments with no Node server to run the route handler (e.g. a
static export) - only appropriate for an endpoint with no secret embedded in its URL.

## 17. Unstyled production build - `output: "standalone"` nesting under a monorepo root

A user deploying to a real Ubuntu VPS (not Docker) reported: build succeeds, standalone server
starts, but the page renders as raw unstyled HTML - CSS and JS chunks not loading. Their own working
run command turned out to be `node .next/standalone/frontend/server.js` - note the extra `frontend/`
segment, which is the actual root cause.

This repo's own root directory (`/opt/flash-loan-arbitrage-bot/` on their VPS, one level above
`frontend/`) has its own `package.json` (from the unrelated Foundry/keeper tooling). Next.js's
`output: "standalone"` file-tracing walks **up** the filesystem from the app directory looking for
the nearest lockfile to infer a monorepo "workspace root." On this VPS, a lockfile also existed at
that root level (most likely from an earlier `npm install` run there for one of the other services
sharing the box - `pm2 list` on their screenshot shows several unrelated apps: `arbitragesmart`,
`dravon`, etc.). Once Next.js infers that outer directory as the root, it nests the *entire*
standalone output to mirror `frontend/`'s position relative to it: `server.js` lands at
`.next/standalone/frontend/server.js`, and critically `.next/standalone/frontend/.next/static`
instead of the "normal" `.next/standalone/.next/static`. Copying static assets to the normal
(non-nested) path - which is what every piece of Next.js's own standalone-deployment documentation
describes - means every `/_next/static/*` request 404s once the server actually runs, and the page
renders with zero CSS/JS, silently, no error anywhere. This is why it also mysteriously never
happened in this project's own Docker build: the Dockerfile's build `context: ./frontend` means
Docker never sees anything above `frontend/` in the first place, so the ambiguity never arises there
- only a direct `npm run build` from within a full clone of the whole monorepo hits it, and only on
machines where a lockfile happens to exist at the repo root (which is filesystem-state-dependent,
not something `next build`'s own output announces).

**Reproduced empirically** before trusting the diagnosis: created a throwaway `package-lock.json` at
the repo root, rebuilt, and confirmed `server.js` did in fact land at
`.next/standalone/frontend/server.js` - exactly matching the user's report. Removed it, rebuilt with
the fix below, recreated the root lockfile again, and confirmed the output stayed flat regardless.

**Fix**: `next.config.ts` now sets `outputFileTracingRoot: path.join(__dirname)`, pinning the
tracing root to `frontend/` itself so Next.js never walks up looking for a workspace root, making
the standalone output layout deterministic - always `.next/standalone/server.js` and
`.next/standalone/.next/static` - on any machine, regardless of what else lives above this directory.

**Verified end-to-end**: full clean build, copied `.next/static` → `.next/standalone/.next/static`
and `public` → `.next/standalone/public` (the standalone output never auto-copies these - a separate,
well-known Next.js requirement, unrelated to the bug above but necessary either way), ran
`PORT=3002 node .next/standalone/server.js` (the user's exact command), and confirmed via Playwright
(network-request tracing + full-page screenshot) that every `/_next/static/*` asset returns 200 and
the page renders with full styling, fonts, and layout.
