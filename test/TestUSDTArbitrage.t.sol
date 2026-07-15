// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {AaveArbitrageExecutorV3} from "../src/AaveArbitrageExecutorV3.sol";
import {TestUSDT} from "../src/mocks/TestUSDT.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockAavePool} from "../src/mocks/MockAavePool.sol";
import {MockRouterV2} from "../src/mocks/MockRouterV2.sol";

/// @notice Covers the two new additions made for the dedicated Flash Swap /
///         Arbitrage test harness (TestUSDT + MockRouterV2.addLiquidity):
///         does NOT duplicate AaveArbitrageExecutor.t.sol's existing
///         coverage of the executor's own revert conditions, gas-aware
///         profit math, per-asset thresholds, etc. - those are already
///         thoroughly tested there.
contract TestUSDTArbitrageTest is Test {
    AaveArbitrageExecutorV3 executor;
    MockAavePool aavePool;

    TestUSDT tUSDT;
    MockERC20 tWBNB;

    MockRouterV2 poolA; // tUSDT/tWBNB, fairly priced
    MockRouterV2 poolB; // tWBNB/tUSDT, deliberately mispriced -> the arb edge

    address owner = makeAddr("owner");
    address keeperBot = makeAddr("keeperBot");
    address profitRecipient = makeAddr("profitRecipient");
    address tester = makeAddr("tester");

    function setUp() public {
        tUSDT = new TestUSDT();
        tWBNB = new MockERC20("Test WBNB", "tWBNB", 18);

        aavePool = new MockAavePool();
        tUSDT.mint(address(aavePool), 50_000_000e18);

        poolA = new MockRouterV2(address(tUSDT), address(tWBNB), 10_000_000e18, 10_000_000e18, 30);
        tUSDT.mint(address(poolA), 10_000_000e18);
        tWBNB.mint(address(poolA), 10_000_000e18);

        poolB = new MockRouterV2(address(tWBNB), address(tUSDT), 8_000_000e18, 12_000_000e18, 30);
        tWBNB.mint(address(poolB), 8_000_000e18);
        tUSDT.mint(address(poolB), 12_000_000e18);

        vm.prank(owner);
        executor = new AaveArbitrageExecutorV3(address(aavePool), profitRecipient, owner);

        vm.startPrank(owner);
        executor.setRouterAllowed(address(poolA), true);
        executor.setRouterAllowed(address(poolB), true);
        executor.setAssetAllowed(address(tUSDT), true, 0);
        executor.setKeeper(keeperBot);
        vm.stopPrank();
    }

    function _steps() internal view returns (AaveArbitrageExecutorV3.SwapStep[] memory steps) {
        steps = new AaveArbitrageExecutorV3.SwapStep[](2);
        steps[0] = AaveArbitrageExecutorV3.SwapStep(address(poolA), address(0), 0, address(tUSDT), address(tWBNB), 0, 0, 0);
        steps[1] = AaveArbitrageExecutorV3.SwapStep(address(poolB), address(0), 0, address(tWBNB), address(tUSDT), 0, 0, 0);
    }

    /// @notice TestUSDT is a plain OZ ERC20 (via MockERC20) with the exact
    ///         name/symbol/decimals requested, and is mintable by anyone.
    function test_TestUSDT_HasCorrectMetadataAndIsMintable() public {
        assertEq(tUSDT.name(), "Test USDT");
        assertEq(tUSDT.symbol(), "tUSDT");
        assertEq(tUSDT.decimals(), 18);

        uint256 before = tUSDT.balanceOf(tester);
        tUSDT.mint(tester, 1_000e18);
        assertEq(tUSDT.balanceOf(tester) - before, 1_000e18);
    }

    /// @notice MockRouterV2.addLiquidity() pulls both tokens via
    ///         transferFrom and correctly increases both reserves.
    function test_AddLiquidity_IncreasesBothReserves() public {
        uint256 reserveABefore = poolA.reserveA();
        uint256 reserveBBefore = poolA.reserveB();

        tUSDT.mint(tester, 500_000e18);
        tWBNB.mint(tester, 500_000e18);
        vm.startPrank(tester);
        tUSDT.approve(address(poolA), 500_000e18);
        tWBNB.approve(address(poolA), 500_000e18);
        poolA.addLiquidity(500_000e18, 500_000e18);
        vm.stopPrank();

        assertEq(poolA.reserveA(), reserveABefore + 500_000e18);
        assertEq(poolA.reserveB(), reserveBBefore + 500_000e18);
    }

    /// @notice Full success path with the new test token + a pool topped up
    ///         via addLiquidity: flash loan taken, cycle executed, tUSDT
    ///         profit lands in profitRecipient.
    function test_FlashSwapArbitrage_WithTestUSDT_RealizesProfit() public {
        // Add liquidity as its own step before executing, exercising the new
        // function in the same flow as the deploy script.
        tUSDT.mint(tester, 1_000_000e18);
        tWBNB.mint(tester, 1_000_000e18);
        vm.startPrank(tester);
        tUSDT.approve(address(poolA), 1_000_000e18);
        tWBNB.approve(address(poolA), 1_000_000e18);
        poolA.addLiquidity(1_000_000e18, 1_000_000e18);
        vm.stopPrank();

        uint256 loanAmount = 100_000e18;
        AaveArbitrageExecutorV3.SwapStep[] memory steps = _steps();

        uint256 expectedProfit = executor.expectedNetProfit(address(tUSDT), loanAmount, steps);
        assertGt(expectedProfit, 0, "setup should be profitable before executing");

        uint256 recipientBefore = tUSDT.balanceOf(profitRecipient);
        vm.prank(keeperBot);
        executor.executeArbitrage(address(tUSDT), loanAmount, steps, 0, 0);

        assertGt(tUSDT.balanceOf(profitRecipient), recipientBefore, "profit recipient should gain tUSDT");
        (uint256 totalOps, uint256 flashLoans,) = executor.getOperationStats();
        assertEq(totalOps, 1);
        assertEq(flashLoans, 1);
    }

    /// @notice Same test-token setup, but with the two pools priced
    ///         identically (no arbitrage edge) - executeArbitrage must
    ///         revert rather than fabricate a profit.
    function test_RevertWhen_TestUSDTSetupHasNoProfitableSpread() public {
        // Re-price poolB to match poolA exactly (no more mispricing).
        MockRouterV2 fairPoolB = new MockRouterV2(address(tWBNB), address(tUSDT), 10_000_000e18, 10_000_000e18, 30);
        tWBNB.mint(address(fairPoolB), 10_000_000e18);
        tUSDT.mint(address(fairPoolB), 10_000_000e18);

        vm.prank(owner);
        executor.setRouterAllowed(address(fairPoolB), true);

        AaveArbitrageExecutorV3.SwapStep[] memory steps = new AaveArbitrageExecutorV3.SwapStep[](2);
        steps[0] = AaveArbitrageExecutorV3.SwapStep(address(poolA), address(0), 0, address(tUSDT), address(tWBNB), 0, 0, 0);
        steps[1] = AaveArbitrageExecutorV3.SwapStep(address(fairPoolB), address(0), 0, address(tWBNB), address(tUSDT), 0, 0, 0);

        uint256 loanAmount = 100_000e18;
        uint256 expectedProfit = executor.expectedNetProfit(address(tUSDT), loanAmount, steps);
        assertEq(expectedProfit, 0, "two equally-priced 0.3%-fee pools back to back should show zero net profit");

        vm.prank(keeperBot);
        vm.expectRevert();
        executor.executeArbitrage(address(tUSDT), loanAmount, steps, 0, 0);
    }
}
