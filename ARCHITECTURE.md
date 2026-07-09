# Architecture

This describes how the pieces fit together and why. For *why each change was made* see
`ARBITRAGE-UPGRADE.md` (a changelog with rationale); for *how to run it* see `README.md`. This file
is the system-level view.

## Components

```
┌─────────────────────────────────────────────────────────────────────┐
│  BNB Chain mainnet                                                   │
│                                                                        │
│   ┌───────────────┐   flashLoanSimple    ┌──────────────────────┐   │
│   │  Aave V3 Pool  │◄──────────────────────┤ AaveArbitrageExecutor│   │
│   │  (real, 3rd-   │──executeOperation()──►│  V3.sol (deployed)   │   │
│   │   party)       │                       │                       │   │
│   └───────────────┘                       │  - whitelists         │   │
│                                             │  - cost/profit checks │   │
│   ┌──────────────┐  swap / quote           │  - oracle sanity      │   │
│   │ PancakeSwap   │◄────────────────────────┤  - reentrancy guard  │   │
│   │ V2/V3, Biswap,│                        │  - Ownable2Step       │   │
│   │ ApeSwap,      │                        └──────────▲────────────┘   │
│   │ BakerySwap,   │                                   │ executeArbitrage()
│   │ Wombat        │                                   │ (owner or keeper only)
│   └──────────────┘                                    │               │
└────────────────────────────────────────────────────────┼───────────────┘
                                                            │ eth_call / tx
                                          ┌─────────────────┴──────────────────┐
                                          │        Off-chain keeper process     │
                                          │                                      │
                                          │  ┌────────────┐   candidates  ┌────┐│
                                          │  │ routes.ts   ├──────────────► scan││
                                          │  │ (multi-DEX  │               │ner ││
                                          │  │  quoting +  │◄──────────────┤.ts ││
                                          │  │  liquidity  │  RPC calls    └─┬──┘│
                                          │  │  filter)    │                 │   │
                                          │  └────────────┘         ranked   │   │
                                          │                       Opportunity[] │
                                          │                                 ▼   │
                                          │  ┌────────────┐          ┌──────────┐│
                                          │  │ metrics.ts │◄─────────┤ keeper.ts││
                                          │  │ (counters) │          │ (trigger,││
                                          │  └────────────┘          │  submit) ││
                                          │                          └────┬─────┘│
                                          │  ┌────────────┐               │      │
                                          │  │ config.ts  │  .env +       │      │
                                          │  │            │  *.json ─────►│      │
                                          │  └────────────┘               │      │
                                          │                                │      │
                                          │  index.ts (entry point) ◄──────┘      │
                                          └────────────────────────────────────────┘
```

## Two-layer design: on-chain safety backstop + off-chain intelligence

This split is deliberate, not incidental:

- **The contract knows nothing about "good routes."** It only knows how to execute a *caller-chosen*
  cycle atomically, safely, and refuse to complete if it isn't actually profitable by the time it's
  executing (`_settleAndDistribute`'s balance check). It has no opinion on which DEXs, tokens, or
  hops are worth trying — that would mean baking market knowledge into immutable bytecode.
- **The keeper knows nothing about fund custody.** It never holds the borrowed funds, never signs
  for the owner's privileged functions (whitelists, caps, withdrawals) unless the same key happens
  to also be the owner. Its only power is *proposing* a trade the contract itself will still
  independently verify.

This mirrors how real MEV/arbitrage infrastructure is built (searcher off-chain, settlement
on-chain) and means a bug in the off-chain scanner can at worst waste gas on a reverted transaction
— it cannot cause the contract to move funds on a bad calculation, because the contract re-derives
profitability itself from live on-chain quotes inside the same transaction that would move funds.

## Off-chain module responsibilities

| Module | Responsibility | Does NOT do |
|---|---|---|
| `routes.ts` | Multi-DEX quoting (V2/V3/Wombat) for a single hop; picks the best-priced venue per hop; illiquid-pool price-impact filter; multi-hop/triangular cycle enumeration | Cost accounting, execution decisions |
| `scanner.ts` | Turns candidates into fully-costed `Opportunity` objects (premium + fees + gas + slippage buffer vs. per-asset threshold); structured accept/reject logging; ranks and returns the list | Sending transactions, holding state across cycles |
| `metrics.ts` | In-memory counters (evaluated/accepted/rejected-by-reason, cumulative estimated profit) | Nothing execution-related; purely observational |
| `keeper.ts` | Trigger loop (poll or per-block), static-vs-dynamic mode dispatch, picks the top *executable* opportunity from the scanner's ranked list and submits it | Quoting or cost math - it trusts the scanner's numbers, then lets the contract re-verify on-chain |
| `config.ts` | Loads and types `.env` + `routes.config.json` / `strategies.json` | Any business logic |
| `index.ts` | Wires up provider/wallet/contract, verifies the configured key is actually authorized on-chain, hands off to `keeper.ts` | Everything else - kept intentionally thin |

## Data flow for one scan cycle (dynamic mode)

1. `keeper.ts`'s trigger fires (new block, or poll interval).
2. `scanner.runScanCycle()` calls `routes.generateCandidateRoutes()`, which for every base asset ×
   intermediate token × router combination calls `findBestHop()` — this queries every whitelisted
   router for that hop (in parallel), applies the illiquid-pool filter to V2-style quotes, and keeps
   the best-quoting one. Results are cached per (tokenIn, tokenOut, amountIn) within the cycle so a
   hop shared by multiple candidate routes is only quoted once.
3. Each assembled 2-hop/3-hop candidate is evaluated: gross output (already net of swap fees) →
   minus slippage buffer → minus flash-loan premium → minus on-chain-estimated gas cost (via
   `estimateGasCostInAsset`, Chainlink-fed) → compared to the per-asset minimum profit threshold.
   Every candidate gets a structured log line either way, and updates `metrics`.
4. Opportunities are sorted by net profit descending; the top 5 are logged as a ranked summary; a
   metrics summary line is logged.
5. `keeper.ts` takes the single best `executable` opportunity (if any) — the contract's own
   same-block replay guard means only one execution can land per block anyway — and submits it
   (or logs what it *would* submit, in `DRY_RUN=true`).
6. The contract's `executeArbitrage()` independently re-quotes the exact same cycle on-chain,
   checks `minSpreadBPS` and the per-asset `minProfitThreshold`, and only *then* requests the flash
   loan. A stale off-chain quote (price moved between step 3 and step 6) just reverts harmlessly —
   no funds are ever at risk from an off-chain miscalculation.

## Security model (contract)

Summarized here; full rationale is in the contract's own NatSpec (`src/AaveArbitrageExecutorV3.sol`
header) — that's the source of truth, this is a pointer to it:

- **Ownable2Step** — a mistyped or unreachable new-owner address can never permanently brick
  ownership; the pending owner must actively accept.
- **Owner / keeper separation** — the keeper hot wallet can only call `executeArbitrage()` within
  owner-set whitelists/caps/thresholds; it cannot reconfigure anything or move funds directly.
- **ReentrancyGuard + same-block guard** — `executeArbitrage()` is `nonReentrant` and additionally
  refuses a second call in the same block, a cheap deterrent against a compromised key or a runaway
  bot spamming the contract.
- **Router/asset whitelists** — nothing not explicitly allow-listed by the owner can ever be called
  or borrowed.
- **Oracle sanity check** — optional Chainlink cross-check on the first hop's DEX-implied price,
  guarding against single-pool manipulation.
- **Timelocked withdrawals** — `requestWithdrawal` → wait `timelockDelay` → `executeWithdrawal`,
  so a compromised owner key can't instantly drain accumulated funds.

## Testing architecture

Two independent suites, deliberately kept separate:

- **`test/AaveArbitrageExecutor.t.sol`** — deterministic, mock-based (`src/mocks/*`), runs anywhere
  with no network access, exercises every code path including router types, threshold logic, and
  the gas-cost helper with engineered numbers designed to actually go negative.
- **`test/ForkBsc.t.sol`** — forks real BNB Chain state (needs your own `--fork-url`; this sandbox
  can't reach one). Proves the contract's wiring against real Aave/DEX/Chainlink contracts, not just
  mocks, and includes the diagnostic test comparing same-DEX vs. cross-DEX pricing that explains why
  naive same-venue triangular routes are usually unprofitable.

## Configuration surface

| Where | What |
|---|---|
| `keeper/.env` | RPC endpoint, private key, executor address, scan mode, trigger mode, poll interval, dry-run flag, logging verbosity |
| `keeper/routes.config.json` | Base assets, intermediate token universe, router registry (with V3 fee tiers), probe amounts, gas units, slippage buffer, execution slippage, max price impact, per-asset profit thresholds |
| `keeper/strategies.json` | Static mode only: fixed hand-authored routes |
| On-chain (owner-only setters) | Router/asset whitelists, per-asset flash-loan caps, per-asset min profit thresholds, min spread, keeper address, price feeds, protocol fee, pause |

## Extension points

- **New V2-style DEX**: add one entry to `routers` in `routes.config.json` (name, address,
  `routerType: 0`) — no code changes. Whitelist it on-chain via `setRouterAllowed`.
- **New V3-style (Uniswap-V3-compatible) DEX**: add a `routerType: 1` entry with `quoterAddress` and
  `feeTiers`. Verify it's genuinely Uniswap-V3-interface-compatible first (Algebra-based forks like
  THENA's V3 are not — see `ARBITRAGE-UPGRADE.md` §6).
- **New Wombat-style pool**: add a `routerType: 3` entry pointing at the pool address directly.
- **New Curve/Ellipsis-style pool**: not auto-scanned (needs per-pool token indices); add it as a
  hand-authored hop in `strategies.json` static mode instead.
- **New base asset**: add to `baseAssets` + a probe amount + a per-asset min profit threshold in
  `routes.config.json`, and whitelist it on-chain via `setAssetAllowed`.
