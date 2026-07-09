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
