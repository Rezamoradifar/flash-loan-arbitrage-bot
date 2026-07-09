# AaveArbitrageExecutorV3 — flash-loan triangular arbitrage bot

Built from an `AaveArbitrageExecutorV2` contract, extended and wired into an automated on-chain +
off-chain system. Tested end-to-end against **local mock contracts** (see "What was actually
tested" below) — it has **not** been deployed to any real network.

## راهنمای سریع (فارسی)

```bash
# ۱) نصب Foundry (فقط یک بار)
curl -L https://foundry.paradigm.xyz | bash
foundryup

# ۲) کلون کردن پروژه و نصب dependency ها
git clone <URL این ریپو>
cd flash-arb
forge install OpenZeppelin/openzeppelin-contracts@v5.1.0 foundry-rs/forge-std@v1.9.6 --no-commit

# ۳) اجرای تست‌ها (کاملاً آفلاین، چیزی دیپلوی نمی‌شود)
forge test -vvv

# ۴) دمو کامل: یک چین محلی بالا می‌آید، قرارداد دیپلوی می‌شود و
#    واقعاً یک فلش‌لون گرفته می‌شود، آربیتراژ سه‌مرحله‌ای اجرا و سود واریز می‌شود
anvil &
forge script script/DeployLocalDemo.s.sol:DeployLocalDemo \
  --rpc-url http://127.0.0.1:8545 \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  --broadcast
```

نکته مهم: هیچ آدرس واقعی Aave/PancakeSwap در کد نیست (عمداً) — چون یک آدرس اشتباه در رباتی که وام
واقعی می‌گیرد می‌تواند فاجعه‌بار باشد. برای اجرای واقعی روی BSC باید خودتان آدرس‌های تأییدشده را از
سایت رسمی Aave و BscScan پیدا کنید (بخش "Deploying against a real Aave V3 pool" پایین همین فایل).
هیچ ربات آربیتراژی سود را تضمین نمی‌کند — این کد فقط زمانی واقعاً وام می‌گیرد که سودآوری را خودش
روی چین چک کرده و تأیید کرده باشد؛ در غیر این صورت تراکنش قبل از گرفتن وام revert می‌شود.

---

## Quick start (normal machine, has internet)

```bash
# 1) install Foundry (one-time)
curl -L https://foundry.paradigm.xyz | bash
foundryup

# 2) clone and fetch dependencies
git clone <this repo's URL>
cd flash-arb
forge install OpenZeppelin/openzeppelin-contracts@v5.1.0 foundry-rs/forge-std@v1.9.6 --no-commit

# 3) run the test suite (fully offline, deploys nothing real)
forge test -vvv

# 4) full local demo: spins up a local chain, deploys the contract, and
#    actually takes a flash loan, runs the triangular arb, and pays out profit
anvil &
forge script script/DeployLocalDemo.s.sol:DeployLocalDemo \
  --rpc-url http://127.0.0.1:8545 \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  --broadcast
```

That private key is Anvil's well-known default dev account #0 — public, funded only on your local
Anvil chain, never use it anywhere real.

Expected output ends with something like:

```
== After ==
Aave pool USDT liquidity: 50000050000000000000000000
Deployer/profitRecipient USDT balance: 43953046057264343431828
Net profit realized: 43953046057264343431828
operationCount: 1
totalFlashLoansExecuted: 1
totalProfitRealized: 43953046057264343431828
```

That's a real flash loan (`FlashLoanStarted`/`FlashLoanRepaid` events), a real 3-hop swap cycle,
and real profit — against local mock DEX/Aave contracts, not real BSC liquidity (see below).

## What changed vs. the contract you sent

`src/AaveArbitrageExecutorV3.sol`:

- **Keeper role.** `executeArbitrage()` used to be `onlyOwner`. It's now `onlyOwnerOrKeeper`. The
  owner (ideally a Safe/multisig) sets a separate `keeper` hot-wallet address via `setKeeper()`.
  The keeper can only trigger trades that are already constrained by owner-set whitelists/caps —
  it can never touch config, whitelists, fees, or withdraw funds. This is what makes the bot
  "automatic": your off-chain script holds the keeper key, not the owner key.
- **Stable-swap router type** (`routerType = 2`), covering Curve/Ellipsis/Wombat-style pools —
  common on BSC for stable-stable triangular routes (e.g. USDT → USDC → BUSD → USDT). This is in
  addition to the V2-style and V3-style routers the original contract already supported.
- **`quoteBestOfV2()`** helper so a keeper can compare several whitelisted routers for the same
  hop in a single `eth_call` instead of one call per router.
- **Fixed an edge-case bug**: the same-block replay guard (`oncePerBlock`) defaulted its "last op
  block" to 0, which collides with `block.number == 0` on a freshly-started chain (Anvil/Hardhat)
  and would make the very first-ever call revert. Now initialized to `type(uint256).max` in the
  constructor.
- Everything else — the whitelist model, oracle sanity check, timelocked withdrawals, pause,
  CEI ordering, `ReentrancyGuard` — is unchanged from the original contract. That security model
  was already solid.

Note on "triangular": the original contract *already* supported 2- and 3-hop cycles
(`asset → X → Y → asset` is exactly a triangular arbitrage). What's new here is *more router
types* to route triangular cycles through (stable pools, not just V2/V3 pools) and the keeper
role that lets a bot actually fire them automatically.

## Project layout

```
flash-arb/
├── src/
│   ├── AaveArbitrageExecutorV3.sol   # the executor contract
│   └── mocks/                        # MockAavePool, MockERC20, MockRouterV2/V3, MockStableSwap
├── test/AaveArbitrageExecutor.t.sol  # Foundry tests (see below)
├── script/
│   ├── Deploy.s.sol                  # deploy against a REAL Aave pool (mainnet/testnet)
│   └── DeployLocalDemo.s.sol         # deploy + run one full arbitrage against local mocks
├── keeper/                           # off-chain TypeScript bot (ethers.js)
│   ├── src/index.ts                  # poll loop: quote → decide → execute
│   ├── strategies.example.json       # route templates (PLACEHOLDER addresses — see below)
│   └── .env.example
└── foundry.toml
```

## What was actually tested, and what wasn't

This was built and tested in a network-restricted sandbox with no outbound access to any
blockchain RPC endpoint (BSC mainnet/testnet, public nodes — all blocked). That means real BSC
state / a real Aave V3 pool / real PancakeSwap pools couldn't be forked or hit directly. Two
consequences:

1. **The Foundry test suite (`test/AaveArbitrageExecutor.t.sol`) runs against mock contracts**,
   not real BSC liquidity: `MockAavePool` (real `flashLoanSimple` borrow/callback/repay flow,
   including the 0.05% premium), and `MockRouterV2` / `MockRouterV3` / `MockStableSwap`
   (constant-product / constant-sum AMMs with configurable reserves). One pool is deliberately
   mispriced relative to the other two, creating a real, on-chain-computed arbitrage edge.
2. Running these tests **does exercise the real code path**: `executeArbitrage()` really calls
   `IAavePool.flashLoanSimple()`, the mock pool really transfers funds and calls back into
   `executeOperation()`, the contract really runs the 3-hop swap cycle, really approves and repays
   Aave principal + premium, and really transfers net profit to `profitRecipient`. What's mocked
   is *the DEX/Aave counterparties*, not the executor's own logic.

Test cases (`test/AaveArbitrageExecutor.t.sol`):

| Test | Proves |
|---|---|
| `test_TriangularArbitrage_TakesFlashLoanAndRealizesProfit` | Full 3-hop cycle: flash loan taken, Aave repaid with premium, real profit transferred |
| `test_OwnerCanAlsoExecuteArbitrage` | Owner retains direct access alongside the keeper |
| `test_RevertWhen_StrangerCallsExecuteArbitrage` | Only owner/keeper can trigger trades |
| `test_RevertWhen_RevokedKeeperCallsExecuteArbitrage` | Revoking the keeper actually revokes access |
| `test_RevertWhen_RouterNotWhitelisted` | Non-whitelisted router blocks the whole cycle |
| `test_RevertWhen_CycleNotProfitable` | **A fairly-priced cycle is rejected *before* any flash loan is taken** — the bot never borrows blindly |
| `test_RevertWhen_SecondCallSameBlock` | Same-block replay guard works |
| `test_ArbitrageWithV3AndStableRouterTypes` | The new stable-swap hop type and the V3-style hop type both execute correctly in a real flash-loan cycle |

`forge test -vvv` prints every event including `FlashLoanStarted`, `SwapExecuted` × N,
`FlashLoanRepaid`, `ArbitrageExecuted`, `ProfitRealized` — worth reading through once.

Also actually **deployed and broadcast** to a live local Anvil node (`script/DeployLocalDemo.s.sol`
via `forge script ... --broadcast`) — a real transaction, independently verified by pulling the
raw tx and event logs back out with `cast`, not just trusting the script's own console output.

**What wasn't done, and why:**

- **No real testnet/mainnet deployment.** That needs a funded wallet + a private key that only you
  should hold. `script/Deploy.s.sol` is ready for you to run yourself with your own key once you've
  verified the target Aave pool address (see below).
- **No forked-mainnet test.** The sandbox this was built in has no RPC access. From a machine with
  normal internet access, `forge test --fork-url <your-bsc-rpc> --fork-block-number <n>` against
  the real Aave pool + real PancakeSwap pools would be the natural next step before ever touching
  mainnet with a keeper key.
- **No "guaranteed profit."** No contract can guarantee that. `test_RevertWhen_CycleNotProfitable`
  demonstrates the honest version of this: the contract *quotes on-chain before borrowing* and
  reverts (no loan taken) if the cycle isn't actually profitable net of fees. Whether a *real*
  profitable spread exists at any given moment on BSC depends on live market conditions and
  competition from other MEV bots — that's true of every arbitrage bot, not a limitation of this
  code.

## Running it

### Normal machine (recommended)

```bash
foundryup   # installs/updates forge, anvil, cast
cd flash-arb
forge install OpenZeppelin/openzeppelin-contracts@v5.1.0 foundry-rs/forge-std@v1.9.6 --no-commit
forge test -vvv
```

### Network-restricted sandbox fallback

If you're in an environment that can't reach the normal solc release servers, there's a
`bin/solc` wrapper here around npm's `solc-js` you can point `foundry.toml` at instead (see the
commented-out `solc =` / `offline =` lines at the bottom of `foundry.toml`):

```bash
npm install solc@0.8.24 --no-save
# then uncomment `solc = "bin/solc"` and `offline = true` in foundry.toml
```

### Deploying against a real Aave V3 pool

```bash
export AAVE_POOL=<verified Aave V3 Pool address for your target chain>
export PROFIT_RECIPIENT=<your address>
export OWNER=<your Safe/multisig address — do NOT use a hot wallet>
export PRIVATE_KEY=<deployer key>
forge script script/Deploy.s.sol:Deploy --rpc-url $RPC_URL --broadcast
```

Then, as the owner, before any real trade can happen:

```solidity
executor.setRouterAllowed(router, true);      // for every DEX router you'll route through
executor.setAssetAllowed(asset, true, cap);   // for every flash-borrowable asset, with a cap
executor.setKeeper(keeperHotWalletAddress);   // the bot's hot wallet, NOT the owner key
executor.setMinSpreadBPS(...);                // tune your risk/profit threshold
executor.setMinProfitThreshold(...);
```

### Running the keeper bot

```bash
cd keeper
npm install
cp .env.example .env      # fill in RPC_URL, PRIVATE_KEY (keeper hot wallet), EXECUTOR_ADDRESS
cp strategies.example.json strategies.json   # fill in REAL, VERIFIED addresses — see below
npm run dry-run            # logs what it WOULD do, sends nothing — always start here
npm start                  # live: sends real executeArbitrage() transactions when profitable
```

The bot polls every `POLL_INTERVAL_MS`, calls the contract's own `expectedNetProfit()` (an
`eth_call`, no gas cost) for each configured strategy, and only sends a real transaction when the
quoted net profit clears your configured threshold. `executeArbitrage()` re-verifies profitability
on-chain in the same transaction before borrowing, so a stale off-chain quote just reverts
harmlessly (loan never taken) rather than losing funds.

## About the addresses in `strategies.example.json`

They're all `0x000...dEaD` placeholders on purpose. **No real Aave/PancakeSwap/BSC contract
addresses are hardcoded anywhere in this bot.** For something that borrows and moves real money, a
single wrong or stale contract address is a catastrophic, silent failure mode — worse than the bot
simply not running. Get every address yourself, freshly, from:

- Aave's own documentation site (aave.com) for the current Pool address on your target chain.
- The DEX's own documentation (e.g. pancakeswap.finance) for router/quoter addresses.
- Cross-check whatever you find against BscScan (bscscan.com) — confirm it's a verified contract
  with the expected interface before whitelisting it.

Do not copy addresses from a random blog post, tutorial, or an AI's memory — verify from the
protocol's own source every time, especially before pointing an automated key at it.

## Security reminders

- **This is not an audit.** Get an independent review before using real funds.
- Use a **multisig (Safe) as the owner**, not an EOA — the constructor takes the owner address
  directly for exactly this reason.
- The **keeper key should hold just enough native gas token and nothing else** — by design it
  can't touch whitelists or withdraw funds, but treat every hot wallet as eventually compromised
  and size its blast radius accordingly.
- Start with small `maxFlashLoanPerAsset` caps and a conservative `minSpreadBPS`, and watch real
  behavior for a while before raising either.

## License

MIT — see `LICENSE`.
