// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {AaveArbitrageExecutorV3} from "../src/AaveArbitrageExecutorV3.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockAavePool} from "../src/mocks/MockAavePool.sol";
import {MockRouterV2} from "../src/mocks/MockRouterV2.sol";
import {MockRouterV3} from "../src/mocks/MockRouterV3.sol";
import {MockStableSwap} from "../src/mocks/MockStableSwap.sol";
import {MockWombatPool} from "../src/mocks/MockWombatPool.sol";
import {MockChainlinkAggregator} from "../src/mocks/MockChainlinkAggregator.sol";

contract AaveArbitrageExecutorTest is Test {
    AaveArbitrageExecutorV3 executor;
    MockAavePool aavePool;

    MockERC20 usdt;
    MockERC20 tokX;
    MockERC20 tokY;
    MockERC20 tokZ;

    MockRouterV2 routerA; // USDT/TOKX
    MockRouterV2 routerB; // TOKX/TOKY
    MockRouterV2 routerC; // TOKY/USDT, deliberately skewed -> the arb edge

    address owner = makeAddr("owner");
    address keeperBot = makeAddr("keeperBot");
    address profitRecipient = makeAddr("profitRecipient");
    address stranger = makeAddr("stranger");

    function setUp() public {
        usdt = new MockERC20("Tether USD", "USDT", 18);
        tokX = new MockERC20("Token X", "TOKX", 18);
        tokY = new MockERC20("Token Y", "TOKY", 18);
        tokZ = new MockERC20("Token Z", "TOKZ", 18);

        aavePool = new MockAavePool();
        usdt.mint(address(aavePool), 50_000_000e18);

        // Fairly priced pools for the first two hops (0.3% fee each).
        routerA = new MockRouterV2(address(usdt), address(tokX), 10_000_000e18, 10_000_000e18, 30);
        usdt.mint(address(routerA), 10_000_000e18);
        tokX.mint(address(routerA), 10_000_000e18);

        routerB = new MockRouterV2(address(tokX), address(tokY), 10_000_000e18, 10_000_000e18, 30);
        tokX.mint(address(routerB), 10_000_000e18);
        tokY.mint(address(routerB), 10_000_000e18);

        // Deliberately skewed pool: less TOKY than USDT relative to the other
        // two pools' implied 1:1 rate, so TOKY -> USDT here pays out ~1.5x
        // fair value. This is the mispricing the arbitrage bot exploits.
        routerC = new MockRouterV2(address(tokY), address(usdt), 8_000_000e18, 12_000_000e18, 30);
        tokY.mint(address(routerC), 8_000_000e18);
        usdt.mint(address(routerC), 12_000_000e18);

        vm.prank(owner);
        executor = new AaveArbitrageExecutorV3(address(aavePool), profitRecipient, owner);

        vm.startPrank(owner);
        executor.setRouterAllowed(address(routerA), true);
        executor.setRouterAllowed(address(routerB), true);
        executor.setRouterAllowed(address(routerC), true);
        executor.setAssetAllowed(address(usdt), true, 0);
        executor.setKeeper(keeperBot);
        vm.stopPrank();
    }

    function _triangularSteps() internal view returns (AaveArbitrageExecutorV3.SwapStep[] memory steps) {
        steps = new AaveArbitrageExecutorV3.SwapStep[](3);
        steps[0] = AaveArbitrageExecutorV3.SwapStep(address(routerA), address(0), 0, address(usdt), address(tokX), 0, 0, 0);
        steps[1] = AaveArbitrageExecutorV3.SwapStep(address(routerB), address(0), 0, address(tokX), address(tokY), 0, 0, 0);
        steps[2] = AaveArbitrageExecutorV3.SwapStep(address(routerC), address(0), 0, address(tokY), address(usdt), 0, 0, 0);
    }

    /// @notice The core ask: prove the contract actually takes a flash loan,
    ///         runs a triangular (3-hop) arbitrage cycle, repays Aave with the
    ///         premium, and lands real net profit in profitRecipient.
    function test_TriangularArbitrage_TakesFlashLoanAndRealizesProfit() public {
        uint256 loanAmount = 100_000e18;
        AaveArbitrageExecutorV3.SwapStep[] memory steps = _triangularSteps();

        uint256 poolBalBefore = usdt.balanceOf(address(aavePool));
        uint256 profitBefore = usdt.balanceOf(profitRecipient);

        vm.expectEmit(true, false, false, true, address(executor));
        emit AaveArbitrageExecutorV3.FlashLoanStarted(address(usdt), loanAmount);

        vm.prank(keeperBot);
        executor.executeArbitrage(address(usdt), loanAmount, steps, 0, 0);

        uint256 premium = executor.estimateFlashLoanFee(loanAmount);
        uint256 poolBalAfter = usdt.balanceOf(address(aavePool));
        uint256 profitAfter = usdt.balanceOf(profitRecipient);

        // Aave was repaid principal + premium in full.
        assertEq(poolBalAfter, poolBalBefore + premium, "flash loan not repaid with premium");
        // Real, positive net profit landed with the configured recipient.
        assertGt(profitAfter, profitBefore, "no profit realized");

        (uint256 totalOps, uint256 flashLoans, uint256 totalProfit) = executor.getOperationStats();
        assertEq(totalOps, 1);
        assertEq(flashLoans, 1);
        assertEq(totalProfit, profitAfter - profitBefore);
    }

    /// @notice The owner (not just the keeper) can also trigger trades directly.
    function test_OwnerCanAlsoExecuteArbitrage() public {
        AaveArbitrageExecutorV3.SwapStep[] memory steps = _triangularSteps();
        vm.prank(owner);
        executor.executeArbitrage(address(usdt), 50_000e18, steps, 0, 0);
        assertEq(executor.operationCount(), 1);
    }

    /// @notice A random address (not owner, not keeper) must never be able to
    ///         trigger a flash loan through this contract.
    function test_RevertWhen_StrangerCallsExecuteArbitrage() public {
        AaveArbitrageExecutorV3.SwapStep[] memory steps = _triangularSteps();
        vm.prank(stranger);
        vm.expectRevert(AaveArbitrageExecutorV3.UnauthorizedKeeper.selector);
        executor.executeArbitrage(address(usdt), 100_000e18, steps, 0, 0);
    }

    /// @notice Revoking the keeper immediately disables its ability to trade,
    ///         without touching the owner's own access.
    function test_RevertWhen_RevokedKeeperCallsExecuteArbitrage() public {
        vm.prank(owner);
        executor.setKeeper(address(0));

        AaveArbitrageExecutorV3.SwapStep[] memory steps = _triangularSteps();
        vm.prank(keeperBot);
        vm.expectRevert(AaveArbitrageExecutorV3.UnauthorizedKeeper.selector);
        executor.executeArbitrage(address(usdt), 100_000e18, steps, 0, 0);
    }

    /// @notice A cycle through a non-whitelisted router must revert before any
    ///         flash loan is requested.
    function test_RevertWhen_RouterNotWhitelisted() public {
        MockRouterV2 rogueRouter = new MockRouterV2(address(usdt), address(tokX), 10_000_000e18, 10_000_000e18, 30);

        AaveArbitrageExecutorV3.SwapStep[] memory steps = _triangularSteps();
        steps[0].router = address(rogueRouter);

        vm.prank(keeperBot);
        vm.expectRevert(AaveArbitrageExecutorV3.RouterNotAllowed.selector);
        executor.executeArbitrage(address(usdt), 100_000e18, steps, 0, 0);
    }

    /// @notice A fairly-priced (no mispricing) triangular cycle must be
    ///         rejected as unprofitable *before* a flash loan is ever taken —
    ///         proving the bot doesn't borrow blindly, only when it has
    ///         already confirmed a profitable spread on-chain.
    function test_RevertWhen_CycleNotProfitable() public {
        // Re-point router C at a fairly-priced pool (same 1:1 ratio as A/B),
        // removing the mispricing that made the cycle profitable.
        MockRouterV2 fairRouterC = new MockRouterV2(address(tokY), address(usdt), 10_000_000e18, 10_000_000e18, 30);
        tokY.mint(address(fairRouterC), 10_000_000e18);
        usdt.mint(address(fairRouterC), 10_000_000e18);

        vm.prank(owner);
        executor.setRouterAllowed(address(fairRouterC), true);

        AaveArbitrageExecutorV3.SwapStep[] memory steps = _triangularSteps();
        steps[2].router = address(fairRouterC);

        uint256 poolBalBefore = usdt.balanceOf(address(aavePool));

        vm.prank(keeperBot);
        vm.expectRevert(AaveArbitrageExecutorV3.SpreadTooLow.selector);
        executor.executeArbitrage(address(usdt), 100_000e18, steps, 0, 0);

        // No loan was ever disbursed.
        assertEq(usdt.balanceOf(address(aavePool)), poolBalBefore);
    }

    /// @notice Same-block replay protection: a second call in the same block
    ///         must revert even if it would otherwise be valid.
    function test_RevertWhen_SecondCallSameBlock() public {
        AaveArbitrageExecutorV3.SwapStep[] memory steps = _triangularSteps();
        vm.prank(keeperBot);
        executor.executeArbitrage(address(usdt), 50_000e18, steps, 0, 0);

        vm.prank(keeperBot);
        vm.expectRevert(AaveArbitrageExecutorV3.SameBlockReentry.selector);
        executor.executeArbitrage(address(usdt), 50_000e18, steps, 0, 0);
    }

    /// @notice Exercises the other two router types (V3-style quoter/router
    ///         and Curve/Ellipsis-style stable pool) in a 2-hop cycle, proving
    ///         the added "stable strategy" swap path also actually executes
    ///         a real flash loan + swap + repay end to end.
    function test_ArbitrageWithV3AndStableRouterTypes() public {
        // V3-style pool skewed so USDT -> TOKZ pays out ~1.5x fair value.
        MockRouterV3 routerV3 = new MockRouterV3(address(usdt), address(tokZ), 8_000_000e18, 12_000_000e18, 30);
        usdt.mint(address(routerV3), 8_000_000e18);
        tokZ.mint(address(routerV3), 12_000_000e18);

        // Stable pool TOKZ -> USDT near 1:1 minus a small 4bps fee.
        address[] memory poolTokens = new address[](2);
        poolTokens[0] = address(tokZ);
        poolTokens[1] = address(usdt);
        MockStableSwap stablePool = new MockStableSwap(poolTokens, 4);
        tokZ.mint(address(stablePool), 5_000_000e18);
        usdt.mint(address(stablePool), 5_000_000e18);

        vm.startPrank(owner);
        executor.setRouterAllowed(address(routerV3), true);
        executor.setRouterAllowed(address(stablePool), true);
        vm.stopPrank();

        AaveArbitrageExecutorV3.SwapStep[] memory steps = new AaveArbitrageExecutorV3.SwapStep[](2);
        steps[0] = AaveArbitrageExecutorV3.SwapStep(
            address(routerV3), address(routerV3), 1, address(usdt), address(tokZ), 3000, 0, 0
        );
        steps[1] = AaveArbitrageExecutorV3.SwapStep(
            address(stablePool), address(0), 2, address(tokZ), address(usdt), 0, 0, 1
        );

        uint256 profitBefore = usdt.balanceOf(profitRecipient);

        vm.prank(keeperBot);
        executor.executeArbitrage(address(usdt), 100_000e18, steps, 0, 0);

        assertGt(usdt.balanceOf(profitRecipient), profitBefore, "no profit from mixed V3+stable route");
    }

    /// @notice Proves the multi-asset threshold bug fix: a per-asset
    ///         threshold set high enough to exceed this cycle's real profit
    ///         correctly blocks the trade, even though the global
    ///         minProfitThreshold (0 by default) would have allowed it.
    function test_RevertWhen_ProfitBelowPerAssetThreshold() public {
        AaveArbitrageExecutorV3.SwapStep[] memory steps = _triangularSteps();

        // The unconstrained cycle nets ~43,953e18 USDT profit (see the main
        // profit test) - set a per-asset floor far above that.
        vm.prank(owner);
        executor.setMinProfitThresholdForAsset(address(usdt), 1_000_000e18);

        vm.prank(keeperBot);
        vm.expectRevert(AaveArbitrageExecutorV3.ArbProfitBelowThreshold.selector);
        executor.executeArbitrage(address(usdt), 100_000e18, steps, 0, 0);
    }

    /// @notice A per-asset threshold set BELOW the global default still lets
    ///         a genuinely profitable trade through - proving the override is
    ///         two-directional (raises OR lowers the effective bar), not a
    ///         one-way tightening.
    function test_PerAssetThresholdOverridesGlobal_AllowsLowerBar() public {
        vm.startPrank(owner);
        executor.setMinProfitThreshold(1_000_000e18); // global: would block everything
        executor.setMinProfitThresholdForAsset(address(usdt), 0); // 0 = explicit fallback to global...
        vm.stopPrank();

        // ...so first confirm the global-only path actually blocks it,
        AaveArbitrageExecutorV3.SwapStep[] memory steps = _triangularSteps();
        vm.prank(keeperBot);
        vm.expectRevert(AaveArbitrageExecutorV3.ArbProfitBelowThreshold.selector);
        executor.executeArbitrage(address(usdt), 100_000e18, steps, 0, 0);

        // then set a real per-asset override low enough to allow it through.
        vm.prank(owner);
        executor.setMinProfitThresholdForAsset(address(usdt), 1e18);

        vm.prank(keeperBot);
        executor.executeArbitrage(address(usdt), 100_000e18, steps, 0, 0);
        assertEq(executor.operationCount(), 1);
    }

    /// @notice Gas-cost-aware profit accounting: with real Chainlink-style
    ///         feeds configured for WBNB and USDT, expectedNetProfitAfterGas
    ///         correctly subtracts a real gas cost (converted from native wei
    ///         into USDT terms) from the gross expected profit, and reports a
    ///         genuinely negative number when gas cost exceeds profit -
    ///         proving the bot can reject gas-unprofitable trades before
    ///         ever sending a transaction.
    function test_ExpectedNetProfitAfterGas_AccountsForRealGasCost() public {
        MockERC20 wbnb = new MockERC20("Wrapped BNB", "WBNB", 18);
        // $600/BNB and $1/USDT, both at Chainlink's usual 8 decimals.
        MockChainlinkAggregator bnbFeed = new MockChainlinkAggregator(600e8, 8);
        MockChainlinkAggregator usdtFeed = new MockChainlinkAggregator(1e8, 8);

        vm.startPrank(owner);
        executor.setPriceFeed(address(wbnb), address(bnbFeed));
        executor.setPriceFeed(address(usdt), address(usdtFeed));
        vm.stopPrank();

        AaveArbitrageExecutorV3.SwapStep[] memory steps = _triangularSteps();
        uint256 loanAmount = 100_000e18;

        uint256 netProfit = executor.expectedNetProfit(address(usdt), loanAmount, steps);
        assertGt(netProfit, 0, "sanity: cycle should be profitable before gas");

        // Tiny gas cost: net-of-gas profit should still be (almost) the same and positive.
        int256 afterTinyGas =
            executor.expectedNetProfitAfterGas(address(usdt), loanAmount, steps, address(wbnb), 500_000, 1 gwei);
        assertGt(afterTinyGas, 0, "should stay profitable after a realistic small gas cost");

        // Absurd gas price: 500,000 gas * 300,000 gwei = 150 BNB ~= $90,000 - dwarfs the
        // ~43,953 USDT profit, so net-of-gas must go negative.
        int256 afterHugeGas =
            executor.expectedNetProfitAfterGas(address(usdt), loanAmount, steps, address(wbnb), 500_000, 300_000 gwei);
        assertLt(afterHugeGas, 0, "must go negative when gas cost swamps profit");
    }

    /// @notice estimateGasCostInAsset returns 0 (not a revert) when the
    ///         required price feeds aren't configured - the documented signal
    ///         for "unknown, use your own off-chain estimate" rather than
    ///         silently treating gas as free.
    function test_EstimateGasCostInAsset_ReturnsZeroWithoutFeeds() public view {
        uint256 cost = executor.estimateGasCostInAsset(address(usdt), address(tokX), 500_000, 5 gwei);
        assertEq(cost, 0);
    }

    /// @notice Exercises the new Wombat-style router type (routerType == 3):
    ///         a favorably-skewed V2 hop into a near-1:1 Wombat hop back to
    ///         USDT, proving a real flash loan + Wombat swap + repay cycle
    ///         actually executes end to end, not just compiles.
    function test_ArbitrageWithWombatRouterType() public {
        // V2 pool skewed so USDT -> TOKX pays out ~1.5x fair value.
        MockRouterV2 skewedRouter = new MockRouterV2(address(usdt), address(tokX), 8_000_000e18, 12_000_000e18, 30);
        usdt.mint(address(skewedRouter), 8_000_000e18);
        tokX.mint(address(skewedRouter), 12_000_000e18);

        // Wombat pool TOKX -> USDT near 1:1 minus a small 5bps haircut.
        address[] memory poolTokens = new address[](2);
        poolTokens[0] = address(tokX);
        poolTokens[1] = address(usdt);
        MockWombatPool wombatPool = new MockWombatPool(poolTokens, 5);
        tokX.mint(address(wombatPool), 5_000_000e18);
        usdt.mint(address(wombatPool), 5_000_000e18);

        vm.startPrank(owner);
        executor.setRouterAllowed(address(skewedRouter), true);
        executor.setRouterAllowed(address(wombatPool), true);
        vm.stopPrank();

        AaveArbitrageExecutorV3.SwapStep[] memory steps = new AaveArbitrageExecutorV3.SwapStep[](2);
        steps[0] = AaveArbitrageExecutorV3.SwapStep(
            address(skewedRouter), address(0), 0, address(usdt), address(tokX), 0, 0, 0
        );
        steps[1] =
            AaveArbitrageExecutorV3.SwapStep(address(wombatPool), address(0), 3, address(tokX), address(usdt), 0, 0, 0);

        uint256 profitBefore = usdt.balanceOf(profitRecipient);

        vm.prank(keeperBot);
        executor.executeArbitrage(address(usdt), 100_000e18, steps, 0, 0);

        assertGt(usdt.balanceOf(profitRecipient), profitBefore, "no profit from Wombat-style route");
    }
}
