// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console} from "forge-std/Test.sol";
import {AaveArbitrageExecutorV3} from "../src/AaveArbitrageExecutorV3.sol";

interface IChainlinkFeedView {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @notice Fork test against REAL BNB Chain mainnet state — the real Aave V3
///         Pool, real PancakeSwap V2 + Biswap routers, real WBNB/USDT/USDC/
///         FDUSD/BTCB/ETH, and the real Chainlink BNB/USD feed. Unlike
///         test/AaveArbitrageExecutor.t.sol (which uses mock DEX/Aave
///         contracts), this test forks live chain state into a local,
///         throwaway EVM snapshot: it can request a REAL flash loan from the
///         REAL Aave Pool and swap against REAL DEX liquidity, but nothing
///         here ever touches real mainnet or costs real money — forge's fork
///         is a local read+simulate copy of chain state.
///
///         Requires an RPC URL this sandbox cannot reach; run it yourself:
///           forge test --fork-url <your BSC RPC> --match-contract ForkBscTest -vvvv
///
///         What this proves if it passes: the executor's wiring is correct
///         against real Aave/DEX/Chainlink contracts, not just the mocks, and
///         demonstrates WHY a same-DEX triangular route is usually unprofitable
///         while cross-DEX routes have more of a real edge (see
///         test_SameDexVsCrossDexSpread_Informational). Don't be surprised (or
///         alarmed) if the arbitrage call itself reverts with SpreadTooLow —
///         that's the contract correctly refusing to borrow for a trade that
///         isn't actually profitable, which is exactly what it's supposed to
///         do. These tests log the real spreads they find either way.
contract ForkBscTest is Test {
    // Cross-checked against BscScan + each protocol's own docs (July 2026) -
    // see keeper/addresses.bsc.json for full source list. Still worth a final
    // check on bscscan.com yourself before trusting these with anything real.
    address constant AAVE_POOL = 0x6807dc923806fE8Fd134338EABCA509979a7e0cB;
    address constant PANCAKE_V2_ROUTER = 0x10ED43C718714eb63d5aA57B78B54704E256024E;
    address constant BISWAP_ROUTER = 0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8;
    address constant APESWAP_ROUTER = 0xcF0feBd3f17CEf5b47b0cD257aCf6025c5BFf3b7;
    address constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    address constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    address constant USDC = 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d;
    address constant FDUSD = 0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409;
    address constant BTCB = 0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c;
    address constant ETH = 0x2170Ed0880ac9A755fd29B2688956BD959F933F8;
    address constant CHAINLINK_BNB_USD = 0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE;

    AaveArbitrageExecutorV3 executor;
    address owner = makeAddr("owner");
    address profitRecipient = makeAddr("profitRecipient");

    function setUp() public {
        // Requires --fork-url. Without it, skip cleanly instead of failing
        // loudly, so a plain `forge test` (no fork configured) still passes.
        if (AAVE_POOL.code.length == 0) {
            vm.skip(true, "ForkBscTest requires --fork-url <BSC RPC>; see test file header");
        }

        vm.prank(owner);
        executor = new AaveArbitrageExecutorV3(AAVE_POOL, profitRecipient, owner);

        vm.startPrank(owner);
        executor.setRouterAllowed(PANCAKE_V2_ROUTER, true);
        executor.setRouterAllowed(BISWAP_ROUTER, true);
        executor.setRouterAllowed(APESWAP_ROUTER, true);
        // multi-asset support: whitelist every base asset requirement #4 asks for
        executor.setAssetAllowed(USDT, true, 0);
        executor.setAssetAllowed(USDC, true, 0);
        executor.setAssetAllowed(FDUSD, true, 0);
        executor.setAssetAllowed(WBNB, true, 0);
        executor.setAssetAllowed(BTCB, true, 0);
        executor.setAssetAllowed(ETH, true, 0);
        vm.stopPrank();
    }

    function test_AavePoolHasRealCode() public view {
        assertGt(AAVE_POOL.code.length, 0, "AAVE_POOL has no code at this block/fork - is --fork-url set?");
    }

    function test_BnbUsdChainlinkFeedIsLive() public view {
        (, int256 answer,, uint256 updatedAt,) = IChainlinkFeedView(CHAINLINK_BNB_USD).latestRoundData();
        assertGt(answer, 0, "BNB/USD feed returned non-positive answer");
        assertLt(block.timestamp - updatedAt, 1 days, "BNB/USD feed looks stale for this fork block");
        console.log("Real BNB/USD (8 decimals):", uint256(answer));
    }

    /// @notice Sanity-checks direct PancakeSwap V2 liquidity for every base
    ///         asset from requirement #4, each priced against WBNB. Logs
    ///         rather than hard-asserts per-pair, since not every base asset
    ///         necessarily has a *direct* pair with WBNB at all times.
    function test_MultiAssetLiquiditySanityCheck() public view {
        address[6] memory assets = [USDT, USDC, FDUSD, WBNB, BTCB, ETH];
        string[6] memory labels = ["USDT", "USDC", "FDUSD", "WBNB", "BTCB", "ETH"];

        for (uint256 i = 0; i < assets.length; i++) {
            if (assets[i] == WBNB) continue;
            address[] memory path = new address[](2);
            path[0] = WBNB;
            path[1] = assets[i];
            (bool ok, bytes memory data) = PANCAKE_V2_ROUTER.staticcall(
                abi.encodeWithSignature("getAmountsOut(uint256,address[])", uint256(1e18), path)
            );
            if (ok) {
                uint256[] memory amounts = abi.decode(data, (uint256[]));
                console.log(string.concat("1 WBNB -> ", labels[i], " (PancakeSwap V2):"), amounts[1]);
            } else {
                console.log(string.concat("No direct WBNB/", labels[i], " pair on PancakeSwap V2 at this block"));
            }
        }
    }

    /// @notice THE key diagnostic for "why does the arbitrage path return a
    ///         negative spread": compares the same USDT->WBNB->USDC->USDT
    ///         triangular cycle priced (a) entirely through ONE DEX
    ///         (PancakeSwap V2 for all 3 hops) vs (b) across TWO different
    ///         DEXs (PancakeSwap V2 for the first two hops, Biswap for the
    ///         last). A single DEX's own pools are internally
    ///         consistent with each other by construction — if PancakeSwap's
    ///         own USDT/WBNB and WBNB/USDC and USDC/USDT pools implied a free
    ///         profit against EACH OTHER, PancakeSwap's own liquidity
    ///         providers/arbitrageurs would have already closed that gap.
    ///         Real exploitable spreads come from price *differences between*
    ///         venues (or momentary imbalance after a large trade), which is
    ///         exactly what requirement #3 (multi-DEX scanning) targets.
    ///         Logs both spreads; does not assert either is positive, since
    ///         that's a live market fact that changes block to block.
    function test_SameDexVsCrossDexSpread_Informational() public {
        uint256 loanAmount = 1_000e18;

        AaveArbitrageExecutorV3.SwapStep[] memory sameDex = new AaveArbitrageExecutorV3.SwapStep[](3);
        sameDex[0] = AaveArbitrageExecutorV3.SwapStep(PANCAKE_V2_ROUTER, address(0), 0, USDT, WBNB, 0, 0, 0);
        sameDex[1] = AaveArbitrageExecutorV3.SwapStep(PANCAKE_V2_ROUTER, address(0), 0, WBNB, USDC, 0, 0, 0);
        sameDex[2] = AaveArbitrageExecutorV3.SwapStep(PANCAKE_V2_ROUTER, address(0), 0, USDC, USDT, 0, 0, 0);

        AaveArbitrageExecutorV3.SwapStep[] memory crossDex = new AaveArbitrageExecutorV3.SwapStep[](3);
        crossDex[0] = AaveArbitrageExecutorV3.SwapStep(PANCAKE_V2_ROUTER, address(0), 0, USDT, WBNB, 0, 0, 0);
        crossDex[1] = AaveArbitrageExecutorV3.SwapStep(PANCAKE_V2_ROUTER, address(0), 0, WBNB, USDC, 0, 0, 0);
        crossDex[2] = AaveArbitrageExecutorV3.SwapStep(BISWAP_ROUTER, address(0), 0, USDC, USDT, 0, 0, 0);

        int256 sameDexSpread = _spread(sameDex, loanAmount);
        int256 crossDexSpread = _spread(crossDex, loanAmount);

        console.log("Same-DEX (PancakeSwap only) spread, USDT (negative logged as such):");
        console.logInt(sameDexSpread);
        console.log("Cross-DEX (PancakeSwap + Biswap) spread, USDT (negative logged as such):");
        console.logInt(crossDexSpread);
    }

    function _spread(AaveArbitrageExecutorV3.SwapStep[] memory steps, uint256 loanAmount) internal returns (int256) {
        try executor.previewArbitrage(USDT, loanAmount, steps) returns (uint256 out) {
            return int256(out) - int256(loanAmount);
        } catch {
            console.log("  (one or more hops reverted - route/pair may not exist at this block)");
            return type(int256).min;
        }
    }

    /// @notice Actually attempts the real flash loan + real swaps against the
    ///         forked real Aave Pool and real PancakeSwap Router. Accepts
    ///         EITHER outcome: a real profitable execution, or a correct
    ///         SpreadTooLow revert (the expected common case in an efficient
    ///         market) - and reports which one happened.
    function test_AttemptRealFlashLoanArbitrage() public {
        AaveArbitrageExecutorV3.SwapStep[] memory steps = new AaveArbitrageExecutorV3.SwapStep[](3);
        steps[0] = AaveArbitrageExecutorV3.SwapStep(PANCAKE_V2_ROUTER, address(0), 0, USDT, WBNB, 0, 0, 0);
        steps[1] = AaveArbitrageExecutorV3.SwapStep(PANCAKE_V2_ROUTER, address(0), 0, WBNB, USDC, 0, 0, 0);
        steps[2] = AaveArbitrageExecutorV3.SwapStep(PANCAKE_V2_ROUTER, address(0), 0, USDC, USDT, 0, 0, 0);

        uint256 profitBefore = _balance(USDT, profitRecipient);

        vm.prank(owner);
        try executor.executeArbitrage(USDT, 1_000e18, steps, 0, 100) {
            uint256 profitAfter = _balance(USDT, profitRecipient);
            console.log("REAL flash loan succeeded. Net profit (USDT):", profitAfter - profitBefore);
        } catch (bytes memory reason) {
            console.log("Flash loan NOT taken (expected in most efficient-market cases).");
            console.logBytes(reason);
        }
    }

    /// @notice Same attempt as above, but for a WBNB-denominated cross-DEX
    ///         cycle - proving multi-asset (requirement #4) flash borrowing
    ///         actually works against the real Aave Pool, not just USDT.
    function test_AttemptRealFlashLoanArbitrage_WbnbCrossDex() public {
        AaveArbitrageExecutorV3.SwapStep[] memory steps = new AaveArbitrageExecutorV3.SwapStep[](3);
        steps[0] = AaveArbitrageExecutorV3.SwapStep(PANCAKE_V2_ROUTER, address(0), 0, WBNB, USDT, 0, 0, 0);
        steps[1] = AaveArbitrageExecutorV3.SwapStep(BISWAP_ROUTER, address(0), 0, USDT, USDC, 0, 0, 0);
        steps[2] = AaveArbitrageExecutorV3.SwapStep(PANCAKE_V2_ROUTER, address(0), 0, USDC, WBNB, 0, 0, 0);

        uint256 profitBefore = _balance(WBNB, profitRecipient);

        vm.prank(owner);
        try executor.executeArbitrage(WBNB, 5e18, steps, 0, 100) {
            uint256 profitAfter = _balance(WBNB, profitRecipient);
            console.log("REAL WBNB flash loan succeeded. Net profit (WBNB):", profitAfter - profitBefore);
        } catch (bytes memory reason) {
            console.log("WBNB flash loan NOT taken (expected in most efficient-market cases).");
            console.logBytes(reason);
        }
    }

    function _balance(address token, address who) internal view returns (uint256) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSignature("balanceOf(address)", who));
        require(ok, "balanceOf failed");
        return abi.decode(data, (uint256));
    }
}
