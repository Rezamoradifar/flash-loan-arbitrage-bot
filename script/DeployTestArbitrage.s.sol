// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {AaveArbitrageExecutorV3} from "../src/AaveArbitrageExecutorV3.sol";
import {TestUSDT} from "../src/mocks/TestUSDT.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockAavePool} from "../src/mocks/MockAavePool.sol";
import {MockRouterV2} from "../src/mocks/MockRouterV2.sol";

/// @notice Dedicated local/testnet harness for the full flash-swap +
///         arbitrage test pipeline, using clearly-labeled test-only tokens
///         (no real value claims - see TestUSDT.sol):
///
///           Deploy Test Tokens
///             -> Create Liquidity Pool
///             -> Add Test Liquidity
///             -> Detect Arbitrage Opportunity
///             -> Execute Flash Swap
///             -> Perform Swaps
///             -> Repay Flash Swap
///             -> Calculate Real Test Profit
///
///         "Perform Swaps" and "Repay Flash Swap" happen inside the single
///         atomic executeArbitrage() transaction (that atomicity is the
///         whole point of a flash loan - if repayment can't be made, the
///         entire transaction, including every swap, reverts as if nothing
///         happened). This script logs each conceptual stage separately so
///         the flow is easy to follow even though two of the on-chain steps
///         share one transaction.
///
///         Existing script/DeployLocalDemo.s.sol is untouched - this is an
///         additional, separate harness, not a replacement.
///
/// Usage:
///   anvil &
///   forge script script/DeployTestArbitrage.s.sol:DeployTestArbitrage \
///     --rpc-url http://127.0.0.1:8545 \
///     --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
///     --broadcast
contract DeployTestArbitrage is Script {
    TestUSDT tUSDT;
    MockERC20 tWBNB;
    MockAavePool aavePool;
    MockRouterV2 poolA; // tUSDT <-> tWBNB, fairly priced
    MockRouterV2 poolB; // tWBNB <-> tUSDT, deliberately mispriced -> the exploitable edge
    AaveArbitrageExecutorV3 executor;

    uint256 constant FLASH_LOAN_AMOUNT = 100_000e18;
    uint256 constant DEPLOYER_MINT_AMOUNT = 5_000_000e18; // for the deployer's own manual testing

    function run() external {
        vm.startBroadcast();
        address deployer = msg.sender;

        console.log("========================================");
        console.log("STEP 1: Deploy Test Tokens");
        console.log("========================================");
        _deployTestTokens(deployer);

        console.log("");
        console.log("========================================");
        console.log("STEP 2: Create Liquidity Pool");
        console.log("========================================");
        _createLiquidityPools();

        console.log("");
        console.log("========================================");
        console.log("STEP 3: Add Test Liquidity");
        console.log("========================================");
        _addTestLiquidity(deployer);

        console.log("");
        console.log("========================================");
        console.log("STEP 4-7: Detect Opportunity, Execute Flash Swap, Perform Swaps, Repay");
        console.log("========================================");
        uint256 profitBefore = tUSDT.balanceOf(deployer);
        AaveArbitrageExecutorV3.SwapStep[] memory steps = _cycleSteps();
        _detectAndExecute(deployer, steps);

        console.log("");
        console.log("========================================");
        console.log("STEP 8: Calculate Real Test Profit");
        console.log("========================================");
        _logFinalProfit(deployer, profitBefore);

        vm.stopBroadcast();
    }

    function _deployTestTokens(address deployer) internal {
        tUSDT = new TestUSDT();
        tWBNB = new MockERC20("Test WBNB", "tWBNB", 18);

        // Mint a working balance directly to the deployer, separate from
        // pool liquidity, so it can be used for further manual testing
        // (sending to other addresses, trying additional swaps, etc.)
        tUSDT.mint(deployer, DEPLOYER_MINT_AMOUNT);

        console.log("tUSDT deployed at:", address(tUSDT));
        console.log("tWBNB deployed at:", address(tWBNB));
        console.log("Minted to deployer (tUSDT):", DEPLOYER_MINT_AMOUNT);
    }

    function _createLiquidityPools() internal {
        aavePool = new MockAavePool();
        tUSDT.mint(address(aavePool), 50_000_000e18);

        // Pool A: fairly priced tUSDT/tWBNB pool.
        poolA = new MockRouterV2(address(tUSDT), address(tWBNB), 10_000_000e18, 10_000_000e18, 30);
        tUSDT.mint(address(poolA), 10_000_000e18);
        tWBNB.mint(address(poolA), 10_000_000e18);

        // Pool B: deliberately mispriced tWBNB/tUSDT pool - this imbalance
        // relative to Pool A is the arbitrage opportunity the flow below
        // detects and captures.
        poolB = new MockRouterV2(address(tWBNB), address(tUSDT), 8_000_000e18, 12_000_000e18, 30);
        tWBNB.mint(address(poolB), 8_000_000e18);
        tUSDT.mint(address(poolB), 12_000_000e18);

        executor = new AaveArbitrageExecutorV3(address(aavePool), msg.sender, msg.sender);
        executor.setRouterAllowed(address(poolA), true);
        executor.setRouterAllowed(address(poolB), true);
        executor.setAssetAllowed(address(tUSDT), true, 0);
        executor.setKeeper(msg.sender);

        console.log("Aave (mock) pool deployed at:", address(aavePool));
        console.log("Pool A (tUSDT/tWBNB) deployed at:", address(poolA));
        console.log("Pool B (tWBNB/tUSDT) deployed at:", address(poolB));
        console.log("Executor deployed at:", address(executor));
    }

    /// @dev Demonstrates the new MockRouterV2.addLiquidity() function as a
    ///      distinct, explicit step - approve then add, exactly like a real
    ///      router's addLiquidity flow, on top of the initial reserves set
    ///      at pool construction above.
    function _addTestLiquidity(address deployer) internal {
        uint256 extraTUSDT = 1_000_000e18;
        uint256 extraTWBNB = 1_000_000e18;

        tUSDT.mint(deployer, extraTUSDT);
        tWBNB.mint(deployer, extraTWBNB);

        tUSDT.approve(address(poolA), extraTUSDT);
        tWBNB.approve(address(poolA), extraTWBNB);
        poolA.addLiquidity(extraTUSDT, extraTWBNB);

        console.log("Added extra liquidity to Pool A - tUSDT:", extraTUSDT);
        console.log("Added extra liquidity to Pool A - tWBNB:", extraTWBNB);
        console.log("Pool A reserves now - tUSDT:", poolA.reserveA());
        console.log("Pool A reserves now - tWBNB:", poolA.reserveB());
    }

    function _cycleSteps() internal view returns (AaveArbitrageExecutorV3.SwapStep[] memory steps) {
        steps = new AaveArbitrageExecutorV3.SwapStep[](2);
        steps[0] = AaveArbitrageExecutorV3.SwapStep(address(poolA), address(0), 0, address(tUSDT), address(tWBNB), 0, 0, 0);
        steps[1] = AaveArbitrageExecutorV3.SwapStep(address(poolB), address(0), 0, address(tWBNB), address(tUSDT), 0, 0, 0);
    }

    function _detectAndExecute(address deployer, AaveArbitrageExecutorV3.SwapStep[] memory steps) internal {
        // "Detect Arbitrage Opportunity": quote the cycle and check expected
        // net profit BEFORE spending gas on a real flash loan - exactly what
        // the off-chain keeper (keeper/src/scanner.ts) does every scan cycle.
        uint256 spreadBPS = executor.previewSpread(address(tUSDT), FLASH_LOAN_AMOUNT, steps);
        uint256 expectedProfit = executor.expectedNetProfit(address(tUSDT), FLASH_LOAN_AMOUNT, steps);
        console.log("Detected gross spread (BPS):", spreadBPS);
        console.log("Detected expected net profit (tUSDT):", expectedProfit);

        require(expectedProfit > 0, "DeployTestArbitrage: no profitable opportunity detected, aborting");

        // "Execute Flash Swap" -> "Perform Swaps" -> "Repay Flash Swap":
        // all three happen atomically inside this one call. If the real
        // on-chain quote at execution time (re-checked internally) turns out
        // unprofitable after all, this reverts harmlessly - the flash loan
        // is never actually taken.
        executor.executeArbitrage(address(tUSDT), FLASH_LOAN_AMOUNT, steps, 0, 0);
        console.log("Flash swap executed, swaps performed, and flash loan repaid in one transaction.");
        console.log("(deployer, not the executor):", deployer);
    }

    function _logFinalProfit(address deployer, uint256 profitBefore) internal view {
        uint256 profitAfter = tUSDT.balanceOf(deployer);
        (uint256 totalOps, uint256 flashLoans, uint256 totalProfit) = executor.getOperationStats();

        console.log("tUSDT balance before:", profitBefore);
        console.log("tUSDT balance after:", profitAfter);
        console.log("Real test profit realized:", profitAfter - profitBefore);
        console.log("operationCount:", totalOps);
        console.log("totalFlashLoansExecuted:", flashLoans);
        console.log("totalProfitRealized (contract-tracked):", totalProfit);
    }
}
